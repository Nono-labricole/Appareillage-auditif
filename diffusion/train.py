"""Entraîne le modèle de diffusion à partir de zéro sur VOS images.

Exemples :
    # Sans mots-clés : toutes les images du dossier (sous-dossiers compris)
    python train.py --data mes_images --out runs/essai1

    # Avec mots-clés : utilise automatiquement mes_images/etiquettes.json (créé par etiqueter.py
    # ou augmenter.py)
    python train.py --data mes_photos_x20 --out runs/moi

    # Utiliser aussi les noms des sous-dossiers comme mots-clés
    python train.py --data mes_images --out runs/essai2 --dossiers-comme-tags

    # Reprendre un entraînement interrompu, ou le continuer après avoir ajouté des photos
    # (même avec de nouveaux mots-clés) : pensez à augmenter --steps
    python train.py --data mes_images --out runs/essai1 --resume --steps 150000
"""
import argparse
import copy
import json
import time
from collections import Counter
from pathlib import Path

import torch
from PIL import ImageOps
from torch.utils.data import DataLoader, Dataset
from torchvision import transforms
from torchvision.utils import save_image

import donnees as D
from diffusion import GaussianDiffusion
from model import UNet


class ImageTagDataset(Dataset):
    def __init__(self, root, image_size, channels, dossiers_comme_tags, flip, utiliser_tags=True):
        self.root = Path(root)
        self.files = D.lister_images(self.root)
        if not self.files:
            raise SystemExit(f"Aucune image trouvée dans {root}")
        etiquettes = D.charger_etiquettes(self.root) if utiliser_tags else {}
        self.regles = D.charger_regles(self.root)
        self.flip = flip

        self.entries = []
        for f in self.files:
            e = etiquettes.get(f)
            tags = set(e["tags"]) if e else set()
            if utiliser_tags and dossiers_comme_tags and "/" in f:
                tags.add(D.normaliser_tag(f.split("/")[0]))
            # Une image sans aucune entrée = "non décrite" (≠ décrite par une liste vide)
            decrite = e is not None or (utiliser_tags and dossiers_comme_tags and "/" in f)
            self.entries.append((f, sorted(tags), e.get("zone") if e else None, decrite))

        self.compte = Counter(t for _, tags, _, _ in self.entries for t in tags)
        self.tags = sorted(self.compte)
        self.index = {t: i for i, t in enumerate(self.tags)}
        self.mode = "L" if channels == 1 else "RGB"
        self.tf = transforms.Compose([
            transforms.Resize((image_size, image_size), interpolation=transforms.InterpolationMode.BICUBIC,
                              antialias=True),
            transforms.ToTensor(),
            transforms.Normalize([0.5] * channels, [0.5] * channels),  # -> [-1, 1]
        ])

    def __len__(self):
        return len(self.entries)

    def __getitem__(self, i):
        f, tags, zone, decrite = self.entries[i]
        img = D.carre(D.ouvrir(self.root / f), zone)  # carré qui garde la zone importante
        if self.flip and torch.rand(()) < 0.5:
            t2 = D.tags_miroir(tags, self.regles)
            if t2 is not None and all(t in self.index for t in t2):
                img, tags = ImageOps.mirror(img), t2
        vec = torch.zeros(max(1, len(self.tags)))
        for t in tags:
            vec[self.index[t]] = 1
        return self.tf(img.convert(self.mode)), vec, decrite


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="dossier contenant vos images d'entraînement")
    ap.add_argument("--out", default="runs/default", help="dossier des checkpoints et échantillons")
    ap.add_argument("--image-size", type=int, default=64)
    ap.add_argument("--channels", type=int, default=3, choices=[1, 3], help="1 = niveaux de gris")
    ap.add_argument("--dossiers-comme-tags", "--conditional", action="store_true",
                    help="le nom du sous-dossier devient un mot-clé")
    ap.add_argument("--sans-tags", action="store_true", help="ignorer etiquettes.json (modèle non conditionnel)")
    ap.add_argument("--sans-miroir", action="store_true", help="ne pas retourner les images pendant l'entraînement")
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

    ds = ImageTagDataset(args.data, args.image_size, args.channels, args.dossiers_comme_tags,
                         flip=not args.sans_miroir, utiliser_tags=not args.sans_tags)
    print(f"{len(ds)} images, {len(ds.tags)} mots-clés")
    if ds.tags:
        print("  " + ", ".join(f"{t} ({n})" for t, n in ds.compte.most_common()))
        rares = [t for t, n in ds.compte.items() if n < 20]
        if rares:
            print(f"  Attention : peu d'exemples (<20) pour : {', '.join(rares)}")

    dl = DataLoader(ds, batch_size=args.batch_size, shuffle=True, drop_last=len(ds) >= args.batch_size,
                    num_workers=args.workers, pin_memory=device == "cuda", persistent_workers=args.workers > 0)

    mults = tuple(int(m) for m in args.channel_mults.split(","))
    attn = tuple(r for r in (32, 16, 8) if r <= args.image_size // 2)[-2:]
    model = UNet(image_size=args.image_size, in_channels=args.channels, base_channels=args.base_channels,
                 channel_mults=mults, attn_resolutions=attn, num_tags=len(ds.tags)).to(device)
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
        anciens = ck.get("tags", [])
        if anciens == ds.tags:
            model.load_state_dict(ck["model"]); ema.load_state_dict(ck["ema"]); opt.load_state_dict(ck["opt"])
        else:
            # Nouveaux mots-clés (nouvelles photos) : on garde tout ce qui a été appris, les nouveaux
            # mots-clés démarrent de zéro ; ceux qui ont disparu sont oubliés.
            if bool(anciens) != bool(ds.tags):
                raise SystemExit("Impossible de reprendre : un modèle sans mots-clés ne peut pas passer à "
                                 "un modèle avec mots-clés (ou l'inverse). Lancez un nouvel entraînement.")
            for cle, cible in (("model", model), ("ema", ema)):
                etat = dict(ck[cle])
                w_old = etat["tag_proj.weight"]
                w_new = torch.zeros(w_old.shape[0], len(ds.tags), dtype=w_old.dtype)
                for j, t in enumerate(ds.tags):
                    if t in anciens:
                        w_new[:, j] = w_old[:, anciens.index(t)]
                etat["tag_proj.weight"] = w_new
                cible.load_state_dict(etat)
            ajoutes = [t for t in ds.tags if t not in anciens]
            retires = [t for t in anciens if t not in ds.tags]
            print(f"Mots-clés ajoutés : {ajoutes or '-'} | retirés : {retires or '-'} "
                  "(l'optimiseur repart de zéro, le reste du modèle est conservé)")
        step = ck["step"]
        print(f"Reprise à l'itération {step}")

    def save():
        torch.save({"model": model.state_dict(), "ema": ema.state_dict(), "opt": opt.state_dict(),
                    "step": step, "config": model.config, "tags": ds.tags, "compte_tags": dict(ds.compte),
                    "timesteps": args.timesteps}, ckpt_path)

    # Pour les aperçus : les mots-clés de quelques vraies images du dataset
    exemples = None
    if ds.tags:
        exemples = torch.stack([ds[i * len(ds) // 16][1] for i in range(16)]).to(device)

    def sample_grid():
        imgs = diffusion.sample(ema, 16, args.image_size, args.channels, steps=50, tags=exemples,
                                guidance_scale=3.0 if exemples is not None else 1.0, device=device)
        save_image((imgs + 1) / 2, out / "samples" / f"{step:07d}.png", nrow=4)

    (out / "args.json").write_text(json.dumps(vars(args), indent=2))
    model.train()
    t0, loss_acc = time.time(), 0.0
    while step < args.steps:
        for x, tags, decrite in dl:
            x = x.to(device, non_blocking=True)
            if ds.tags:
                tags, keep = tags.to(device), decrite.to(device)
            else:
                tags = keep = None
            with torch.autocast("cuda", dtype=torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16,
                                enabled=use_amp):
                loss = diffusion.loss(model, x, tags, keep)
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
