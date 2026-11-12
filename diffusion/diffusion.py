"""Processus de diffusion (DDPM) : ajout de bruit, perte d'entraînement et échantillonnage."""
import math

import torch
import torch.nn.functional as F


def cosine_beta_schedule(timesteps: int, s: float = 0.008) -> torch.Tensor:
    """Planning de bruit cosinus (Nichol & Dhariwal, 2021)."""
    x = torch.linspace(0, timesteps, timesteps + 1, dtype=torch.float64)
    alphas_cumprod = torch.cos(((x / timesteps) + s) / (1 + s) * math.pi / 2) ** 2
    alphas_cumprod = alphas_cumprod / alphas_cumprod[0]
    betas = 1 - (alphas_cumprod[1:] / alphas_cumprod[:-1])
    return betas.clamp(0, 0.999)


class GaussianDiffusion:
    def __init__(self, timesteps: int = 1000, device="cpu"):
        self.timesteps = timesteps
        betas = cosine_beta_schedule(timesteps)
        alphas_cumprod = torch.cumprod(1.0 - betas, dim=0)
        self.alphas_cumprod = alphas_cumprod.float().to(device)

    def _a(self, t, shape):
        return self.alphas_cumprod[t].view(-1, *([1] * (len(shape) - 1)))

    # ------------------------------------------------------------------ train
    def q_sample(self, x0, t, noise):
        """Bruite x0 jusqu'au pas t : x_t = sqrt(a) * x0 + sqrt(1 - a) * bruit."""
        a = self._a(t, x0.shape)
        return a.sqrt() * x0 + (1 - a).sqrt() * noise

    def loss(self, model, x0, y=None, cond_drop_prob: float = 0.1):
        b = x0.shape[0]
        t = torch.randint(0, self.timesteps, (b,), device=x0.device)
        noise = torch.randn_like(x0)
        xt = self.q_sample(x0, t, noise)
        if y is not None and cond_drop_prob > 0:
            # On "oublie" parfois la classe pour apprendre aussi le mode non conditionnel
            drop = torch.rand(b, device=x0.device) < cond_drop_prob
            y = torch.where(drop, torch.full_like(y, model.num_classes), y)
        pred = model(xt, t, y)
        return F.mse_loss(pred, noise)

    # ----------------------------------------------------------------- sample
    @torch.no_grad()
    def sample(self, model, n, image_size, channels=3, steps=100, eta=0.0,
               y=None, guidance_scale=1.0, device="cpu", generator=None):
        """Échantillonnage DDIM : `steps` pas au lieu de 1000 (eta=1 ≈ DDPM)."""
        model.eval()
        x = torch.randn(n, channels, image_size, image_size, device=device, generator=generator)
        ts = torch.linspace(self.timesteps - 1, 0, steps, device=device).long()
        for i, t in enumerate(ts):
            t_batch = t.repeat(n)
            eps = self._predict_eps(model, x, t_batch, y, guidance_scale)
            a_t = self.alphas_cumprod[t]
            a_prev = self.alphas_cumprod[ts[i + 1]] if i + 1 < len(ts) else torch.tensor(1.0, device=device)
            x0 = ((x - (1 - a_t).sqrt() * eps) / a_t.sqrt()).clamp(-1, 1)
            eps = (x - a_t.sqrt() * x0) / (1 - a_t).sqrt()  # cohérent avec x0 clampé
            sigma = eta * ((1 - a_prev) / (1 - a_t) * (1 - a_t / a_prev)).sqrt()
            noise = torch.randn(x.shape, device=device, generator=generator) if i + 1 < len(ts) else 0
            x = a_prev.sqrt() * x0 + (1 - a_prev - sigma**2).clamp(min=0).sqrt() * eps + sigma * noise
        return x

    def _predict_eps(self, model, x, t, y, guidance_scale):
        if y is None or guidance_scale == 1.0:
            return model(x, t, y)
        uncond = torch.full_like(y, model.num_classes)
        eps_c, eps_u = model(torch.cat([x, x]), torch.cat([t, t]), torch.cat([y, uncond])).chunk(2)
        return eps_u + guidance_scale * (eps_c - eps_u)
