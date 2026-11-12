"""Génère des images avec un modèle que vous avez entraîné.

Exemples :
    python sample.py --ckpt runs/essai1/checkpoint.pt --n 16 --out generees.png
    python sample.py --ckpt runs/essai2/checkpoint.pt --classe chats --guidance 4
    python sample.py --ckpt runs/essai1/checkpoint.pt --n 32 --separate --out-dir images/
"""
import argparse
from pathlib import Path

import torch
from torchvision.utils import save_image

from diffusion import GaussianDiffusion
from model import UNet


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--n", type=int, default=16, help="nombre d'images")
    ap.add_argument("--steps", type=int, default=100, help="pas de débruitage (plus = meilleur mais plus lent)")
    ap.add_argument("--eta", type=float, default=0.0, help="0 = DDIM déterministe, 1 = DDPM stochastique")
    ap.add_argument("--classe", default=None, help="nom de la classe (modèle conditionnel)")
    ap.add_argument("--guidance", type=float, default=3.0, help="force du guidage par classe")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", default="generees.png", help="grille d'images")
    ap.add_argument("--separate", action="store_true", help="enregistrer chaque image séparément")
    ap.add_argument("--out-dir", default="generees")
    ap.add_argument("--no-ema", action="store_true", help="utiliser les poids bruts au lieu de l'EMA")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    ck = torch.load(args.ckpt, map_location=device)
    cfg = ck["config"]
    model = UNet(**cfg).to(device)
    model.load_state_dict(ck["model"] if args.no_ema else ck["ema"])

    classes = ck.get("classes", [])
    y = None
    if classes:
        if args.classe is None:
            y = torch.arange(args.n, device=device) % len(classes)  # toutes les classes à tour de rôle
        elif args.classe in classes:
            y = torch.full((args.n,), classes.index(args.classe), device=device)
        else:
            raise SystemExit(f"Classe inconnue. Disponibles : {classes}")
        print(f"Classes : {classes}")

    gen = torch.Generator(device).manual_seed(args.seed) if args.seed is not None else None
    diffusion = GaussianDiffusion(ck.get("timesteps", 1000), device)
    imgs = diffusion.sample(model, args.n, cfg["image_size"], cfg["in_channels"], steps=args.steps,
                            eta=args.eta, y=y, guidance_scale=args.guidance if y is not None else 1.0,
                            device=device, generator=gen)
    imgs = (imgs + 1) / 2

    if args.separate:
        d = Path(args.out_dir); d.mkdir(parents=True, exist_ok=True)
        for i, im in enumerate(imgs):
            save_image(im, d / f"{i:04d}.png")
        print(f"{args.n} images dans {d}/")
    else:
        save_image(imgs, args.out, nrow=int(args.n ** 0.5) or 1)
        print(f"Grille enregistrée : {args.out}")


if __name__ == "__main__":
    main()
