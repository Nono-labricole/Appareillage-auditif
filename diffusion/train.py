"""Entraîne le modèle de diffusion à partir de zéro sur VOS images.

Exemples :
    # Non conditionnel : toutes les images dans un dossier (sous-dossiers acceptés)
    python train.py --data mes_images --out runs/essai1

    # Conditionnel par classe : un sous-dossier = une classe
    #   mes_images/chats/*.jpg, mes_images/chiens/*.jpg ...
    python train.py --data mes_images --out runs/essai2 --conditional

    # Reprendre un entraînement interrompu
    python train.py --data mes_images --out runs/essai1 --resume
"""
import argparse
import copy
import json
import time
from pathlib import Path

import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from torchvision.utils import save_image

from diffusion import GaussianDiffusion
from model import UNet

EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif", ".tif", ".tiff"}


class ImageFolderDataset(Dataset):
    def __init__(self, root, image_size, channels, conditional):
        root = Path(root)
        self.files = sorted(p for p in root.rglob("*") if p.suffix.lower() in EXTS)
        if not self.files:
            raise SystemExit(f"Aucune image trouvée dans {root}")
        self.classes = []
        if conditional:
            self.classes = sorted({p.relative_to(root).parts[0] for p in self.files if len(p.relative_to(root).parts) > 1})
            if not self.classes:
                raise SystemExit("--conditional demande un sous-dossier par classe dans --data")
            self.files = [p for p in self.files if len(p.relative_to(root).parts) > 1]
        self.root = root
        self.mode = "L" if channels == 1 else "RGB"
        self.tf = transforms.Compose([
            transforms.Resize(image_size, interpolation=transforms.InterpolationMode.BICUBIC, antialias=True),
            transforms.CenterCrop(image_size),
            transforms.RandomHorizontalFlip(),
            transforms.ToTensor(),
            transforms.Normalize([0.5] * channels, [0.5] * channels),  # -> [-1, 1]
        ])

    def __len__(self):
        return len(self.files)

    def __getitem__(self, i):
        p = self.files[i]
        img = self.tf(Image.open(p).convert(self.mode))
        label = self.classes.index(p.relative_to(self.root).parts[0]) if self.classes else -1
        return img, label


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="dossier contenant vos images d'entraînement")
    ap.add_argument("--out", default="runs/default", help="dossier des checkpoints et échantillons")
    ap.add_argument("--image-size", type=int, default=64)
    ap.add_argument("--channels", type=int, default=3, choices=[1, 3], help="1 = niveaux de gris")
    ap.add_argument("--conditional", action="store_true", help="conditionner sur les sous-dossiers (classes)")
    ap.add_argument("--base-channels", type=int, default=64, help="largeur du réseau (taille du modèle)")
    ap.add_argument("--channel-mults", default="1,2,2,4")
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--steps", type=int, default=100_000, help="nombre total d'itérations")
    ap.add_argument("--timesteps", type=int, default=1000)
    ap.add_argument("--ema", type=float, default=0.9995)
    ap.add_argument("--sample-every", type=int, default=2000)
    ap.add_argument("--save-every", type=int, default=5000)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"Appareil : {device}")
    out = Path(args.out)
    (out / "samples").mkdir(parents=True, exist_ok=True)

    ds = ImageFolderDataset(args.data, args.image_size, args.channels, args.conditional)
    print(f"{len(ds)} images" + (f", classes : {ds.classes}" if ds.classes else ""))
    dl = DataLoader(ds, batch_size=args.batch_size, shuffle=True, drop_last=len(ds) >= args.batch_size,
                    num_workers=args.workers, pin_memory=device == "cuda", persistent_workers=args.workers > 0)

    mults = tuple(int(m) for m in args.channel_mults.split(","))
    attn = tuple(r for r in (32, 16, 8) if r <= args.image_size // 2)[-2:]
    model = UNet(image_size=args.image_size, in_channels=args.channels, base_channels=args.base_channels,
                 channel_mults=mults, attn_resolutions=attn, num_classes=len(ds.classes)).to(device)
    ema = copy.deepcopy(model).eval().requires_grad_(False)
    print(f"Paramètres : {sum(p.numel() for p in model.parameters()) / 1e6:.1f} M (initialisés aléatoirement)")

    diffusion = GaussianDiffusion(args.timesteps, device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=0.0)
    use_amp = device == "cuda"
    scaler = torch.amp.GradScaler("cuda", enabled=use_amp)

    step = 0
    ckpt_path = out / "checkpoint.pt"
    if args.resume and ckpt_path.exists():
        ck = torch.load(ckpt_path, map_location=device)
        model.load_state_dict(ck["model"]); ema.load_state_dict(ck["ema"]); opt.load_state_dict(ck["opt"])
        step = ck["step"]
        print(f"Reprise à l'itération {step}")

    def save():
        torch.save({"model": model.state_dict(), "ema": ema.state_dict(), "opt": opt.state_dict(),
                    "step": step, "config": model.config, "classes": ds.classes,
                    "timesteps": args.timesteps}, ckpt_path)

    def sample_grid():
        n = 16
        y = torch.arange(n, device=device) % len(ds.classes) if ds.classes else None
        imgs = diffusion.sample(ema, n, args.image_size, args.channels, steps=50, y=y,
                                guidance_scale=3.0 if ds.classes else 1.0, device=device)
        save_image((imgs + 1) / 2, out / "samples" / f"{step:07d}.png", nrow=4)

    (out / "args.json").write_text(json.dumps(vars(args), indent=2))
    model.train()
    t0, loss_acc = time.time(), 0.0
    while step < args.steps:
        for x, y in dl:
            x = x.to(device, non_blocking=True)
            y = y.to(device) if ds.classes else None
            with torch.autocast("cuda", dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
                                enabled=use_amp):
                loss = diffusion.loss(model, x, y)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()

            # Moyenne mobile des poids (EMA) : donne de bien meilleures images
            decay = min(args.ema, (1 + step) / (10 + step))
            with torch.no_grad():
                for pe, pm in zip(ema.parameters(), model.parameters()):
                    pe.lerp_(pm, 1 - decay)
                for be, bm in zip(ema.buffers(), model.buffers()):
                    be.copy_(bm)

            step += 1
            loss_acc += loss.item()
            if step % 100 == 0:
                print(f"it {step:>7} | perte {loss_acc / 100:.4f} | {100 / (time.time() - t0):.1f} it/s", flush=True)
                t0, loss_acc = time.time(), 0.0
            if step % args.sample_every == 0:
                sample_grid(); model.train()
            if step % args.save_every == 0:
                save()
            if step >= args.steps:
                break
    save()
    sample_grid()
    print(f"Terminé. Checkpoint : {ckpt_path}")


if __name__ == "__main__":
    main()
