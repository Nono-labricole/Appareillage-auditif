"""U-Net de débruitage, initialisé aléatoirement (aucun poids pré-entraîné).

Le réseau reçoit une image bruitée x_t et le pas de temps t, et prédit le bruit
qui a été ajouté. Il peut optionnellement être conditionné par une classe
(un sous-dossier de votre dataset = une classe).
"""
import math

import torch
import torch.nn as nn
import torch.nn.functional as F


def timestep_embedding(t: torch.Tensor, dim: int) -> torch.Tensor:
    """Encodage sinusoïdal du pas de temps (comme dans les Transformers)."""
    half = dim // 2
    freqs = torch.exp(-math.log(10000) * torch.arange(half, device=t.device) / half)
    args = t.float()[:, None] * freqs[None]
    return torch.cat([torch.sin(args), torch.cos(args)], dim=-1)


def norm(ch: int) -> nn.GroupNorm:
    return nn.GroupNorm(min(32, ch), ch)


class ResBlock(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, emb_dim: int, dropout: float):
        super().__init__()
        self.norm1 = norm(in_ch)
        self.conv1 = nn.Conv2d(in_ch, out_ch, 3, padding=1)
        self.emb = nn.Linear(emb_dim, out_ch * 2)  # scale & shift
        self.norm2 = norm(out_ch)
        self.dropout = nn.Dropout(dropout)
        self.conv2 = nn.Conv2d(out_ch, out_ch, 3, padding=1)
        nn.init.zeros_(self.conv2.weight)  # le bloc démarre proche de l'identité
        nn.init.zeros_(self.conv2.bias)
        self.skip = nn.Conv2d(in_ch, out_ch, 1) if in_ch != out_ch else nn.Identity()

    def forward(self, x, emb):
        h = self.conv1(F.silu(self.norm1(x)))
        scale, shift = self.emb(F.silu(emb))[:, :, None, None].chunk(2, dim=1)
        h = self.norm2(h) * (1 + scale) + shift
        h = self.conv2(self.dropout(F.silu(h)))
        return h + self.skip(x)


class AttnBlock(nn.Module):
    def __init__(self, ch: int, heads: int = 4):
        super().__init__()
        self.norm = norm(ch)
        self.qkv = nn.Conv2d(ch, ch * 3, 1)
        self.proj = nn.Conv2d(ch, ch, 1)
        nn.init.zeros_(self.proj.weight)
        nn.init.zeros_(self.proj.bias)
        self.heads = heads

    def forward(self, x):
        b, c, h, w = x.shape
        q, k, v = self.qkv(self.norm(x)).reshape(b, 3, self.heads, c // self.heads, h * w).unbind(1)
        out = F.scaled_dot_product_attention(q.transpose(-1, -2), k.transpose(-1, -2), v.transpose(-1, -2))
        out = out.transpose(-1, -2).reshape(b, c, h, w)
        return x + self.proj(out)


class UNet(nn.Module):
    def __init__(
        self,
        image_size: int = 64,
        in_channels: int = 3,
        base_channels: int = 64,
        channel_mults=(1, 2, 2, 4),
        num_res_blocks: int = 2,
        attn_resolutions=(16, 8),
        dropout: float = 0.1,
        num_classes: int = 0,
    ):
        super().__init__()
        self.config = dict(
            image_size=image_size, in_channels=in_channels, base_channels=base_channels,
            channel_mults=tuple(channel_mults), num_res_blocks=num_res_blocks,
            attn_resolutions=tuple(attn_resolutions), dropout=dropout, num_classes=num_classes,
        )
        self.base_channels = base_channels
        self.num_classes = num_classes
        emb_dim = base_channels * 4
        self.time_mlp = nn.Sequential(
            nn.Linear(base_channels, emb_dim), nn.SiLU(), nn.Linear(emb_dim, emb_dim)
        )
        # Index num_classes = "pas de classe" (utilisé pour le classifier-free guidance)
        self.class_emb = nn.Embedding(num_classes + 1, emb_dim) if num_classes > 0 else None

        self.input_conv = nn.Conv2d(in_channels, base_channels, 3, padding=1)

        # --- Encodeur ---
        self.down = nn.ModuleList()
        chans = [base_channels]
        ch, res = base_channels, image_size
        for level, mult in enumerate(channel_mults):
            for _ in range(num_res_blocks):
                out_ch = base_channels * mult
                layers = [ResBlock(ch, out_ch, emb_dim, dropout)]
                if res in attn_resolutions:
                    layers.append(AttnBlock(out_ch))
                self.down.append(nn.ModuleList(layers))
                ch = out_ch
                chans.append(ch)
            if level != len(channel_mults) - 1:
                self.down.append(nn.ModuleList([nn.Conv2d(ch, ch, 3, stride=2, padding=1)]))
                chans.append(ch)
                res //= 2

        # --- Milieu ---
        self.mid1 = ResBlock(ch, ch, emb_dim, dropout)
        self.mid_attn = AttnBlock(ch)
        self.mid2 = ResBlock(ch, ch, emb_dim, dropout)

        # --- Décodeur ---
        self.up = nn.ModuleList()
        for level, mult in reversed(list(enumerate(channel_mults))):
            for i in range(num_res_blocks + 1):
                out_ch = base_channels * mult
                layers = [ResBlock(ch + chans.pop(), out_ch, emb_dim, dropout)]
                if res in attn_resolutions:
                    layers.append(AttnBlock(out_ch))
                ch = out_ch
                if level != 0 and i == num_res_blocks:
                    layers.append(nn.Upsample(scale_factor=2, mode="nearest"))
                    layers.append(nn.Conv2d(ch, ch, 3, padding=1))
                    res *= 2
                self.up.append(nn.ModuleList(layers))

        self.out = nn.Sequential(norm(ch), nn.SiLU(), nn.Conv2d(ch, in_channels, 3, padding=1))
        nn.init.zeros_(self.out[-1].weight)
        nn.init.zeros_(self.out[-1].bias)

    def forward(self, x, t, y=None):
        emb = self.time_mlp(timestep_embedding(t, self.base_channels))
        if self.class_emb is not None:
            if y is None:
                y = torch.full((x.shape[0],), self.num_classes, device=x.device, dtype=torch.long)
            emb = emb + self.class_emb(y)

        h = self.input_conv(x)
        hs = [h]
        for layers in self.down:
            for layer in layers:
                h = layer(h, emb) if isinstance(layer, ResBlock) else layer(h)
            hs.append(h)

        h = self.mid2(self.mid_attn(self.mid1(h, emb)), emb)

        for layers in self.up:
            h = torch.cat([h, hs.pop()], dim=1)
            for layer in layers:
                h = layer(h, emb) if isinstance(layer, ResBlock) else layer(h)

        return self.out(h)
