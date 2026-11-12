"""Génère des images avec un modèle que vous avez entraîné.

Exemples :
    python sample.py --ckpt runs/moi/checkpoint.pt --liste-tags
    python sample.py --ckpt runs/moi/checkpoint.pt --tags "short, lunettes" --n 16
    python sample.py --ckpt runs/moi/checkpoint.pt --tags "lunettes" --sans "short" --guidance 4
    python sample.py --ckpt runs/essai1/checkpoint.pt --n 32 --separate --out-dir images/
"""
import argparse
from pathlib import Path

import torch
from torchvision.utils import save_image

import donnees as D
from diffusion import GaussianDiffusion
from model import UNet


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--n", type=int, default=16, help="nombre d'images")
    ap.add_argument("--tags", default=None, help="mots-clés voulus, séparés par des virgules")
    ap.add_argument("--sans", default=None,
                    help="mots-clés à éviter (sinon le modèle choisit librement ceux qui ne sont pas donnés)")
    ap.add_argument("--liste-tags", action="store_true", help="afficher les mots-clés connus du modèle et quitter")
    ap.add_argument("--guidance", type=float, default=3.0,
                    help="à quel point respecter les mots-clés (1 = pas de guidage, 3–5 = conseillé)")
    ap.add_argument("--steps", type=int, default=100, help="pas de débruitage (plus = meilleur mais plus lent)")
    ap.add_argument("--eta", type=float, default=0.0, help="0 = DDIM déterministe, 1 = DDPM stochastique")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--out", default="generees.png", help="grille d'images")
    ap.add_argument("--separate", action="store_true", help="enregistrer chaque image séparément")
    ap.add_argument("--out-dir", default="generees")
    ap.add_argument("--no-ema", action="store_true", help="utiliser les poids bruts au lieu de l'EMA")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
    ck = torch.load(args.ckpt, map_location=device)
    cfg = ck["config"]
    vocab = ck.get("tags", [])

    if args.liste_tags:
        compte = ck.get("compte_tags", {})
        print("\n".join(f"{t} ({compte.get(t, '?')} images)" for t in vocab) or "Ce modèle n'a pas de mots-clés.")
        return

    model = UNet(**cfg).to(device)
    model.load_state_dict(ck["model"] if args.no_ema else ck["ema"])

    tags = tags_neg = None
    if args.tags or args.sans:
        if not vocab:
            raise SystemExit("Ce modèle a été entraîné sans mots-clés.")
        tags = torch.zeros(args.n, len(vocab), device=device)
        tags_neg = None

        def lire(s):
            mots = [D.normaliser_tag(t) for t in (s or "").split(",") if t.strip()]
            inconnus = [t for t in mots if t not in vocab]
            if inconnus:
                raise SystemExit(f"Mots-clés inconnus : {inconnus}\nConnus : {', '.join(vocab)}")
            return [vocab.index(t) for t in mots]

        for i in lire(args.tags):
            tags[:, i] = 1
        neg = lire(args.sans)
        if neg:
            tags_neg = torch.zeros_like(tags)
            tags_neg[:, neg] = 1
        print(f"Mots-clés : {args.tags or '-'}" + (f" | sans : {args.sans}" if args.sans else ""))

    gen = torch.Generator(device).manual_seed(args.seed) if args.seed is not None else None
    diffusion = GaussianDiffusion(ck.get("timesteps", 1000), device)
    imgs = diffusion.sample(model, args.n, cfg["image_size"], cfg["in_channels"], steps=args.steps,
                            eta=args.eta, tags=tags, guidance_scale=args.guidance if tags is not None else 1.0,
                            device=device, generator=gen, tags_neg=tags_neg)
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
