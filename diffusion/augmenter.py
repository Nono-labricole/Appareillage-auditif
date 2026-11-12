"""Multiplie vos photos authentiques en variantes, sans aucun modèle de génération.

Chaque variante est une transformation simple d'une vraie photo : miroir, recadrage,
légère rotation, lumière/contraste, noir et blanc. Les mots-clés suivent : une photo
retournée échange « droite » et « gauche », une photo en noir et blanc reçoit le
mot-clé « noir et blanc », la zone importante n'est jamais coupée, etc. (voir regles.json).

Exemple :
    python augmenter.py --source mes_photos --sortie mes_photos_x20 --par-image 20

Relancer la même commande après avoir ajouté ou corrigé des photos ne refait que ce qui a
changé : nouvelles photos, photos dont les mots-clés ou la zone ont changé ; les variantes
des photos supprimées sont effacées.
"""
import hashlib
import json
import argparse
import random
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

import donnees as D


def rotation(img, angle):
    """Petite rotation sans coins noirs : on prolonge l'image en miroir avant de tourner."""
    if abs(angle) < 0.1:
        return img
    W, H = img.size
    p = int(0.25 * max(W, H))
    arr = np.pad(np.asarray(img), ((p, p), (p, p), (0, 0)), mode="reflect")
    big = Image.fromarray(arr).rotate(angle, resample=Image.BICUBIC)
    return big.crop((p, p, p + W, p + H))


def variante(img, tags, zone, regles, rng, nb_permis=True):
    """Renvoie (image, tags, description) pour une variante aléatoire."""
    tags = list(tags)
    desc = []

    # Miroir gauche/droite (avec échange des mots-clés)
    if rng.random() < 0.5:
        t2 = D.tags_miroir(tags, regles)
        if t2 is not None:
            img, tags, zone = ImageOps.mirror(img), t2, D.zone_miroir(zone)
            desc.append("miroir")

    # Légère rotation (la zone est agrandie un peu par sécurité)
    angle = rng.uniform(-regles["rotation_max"], regles["rotation_max"])
    if abs(angle) >= 0.5:
        img = rotation(img, angle)
        if zone:
            m = 0.04
            zone = [max(0, zone[0] - m), max(0, zone[1] - m), min(1, zone[2] + m), min(1, zone[3] + m)]
        desc.append(f"rot={angle:+.1f}")

    # Recadrage carré qui garde toujours la zone importante
    emin = 0.95 if D.recadrage_interdit(tags, regles) else regles["recadrage_min"]
    echelle = rng.uniform(emin, 1.0)
    img = D.carre(img, zone, echelle, rng)
    desc.append(f"cadre={echelle:.2f}")

    # Lumière, contraste, saturation, netteté : modérés pour ne pas changer le sens
    for nom, Enh in (("lum", ImageEnhance.Brightness), ("contraste", ImageEnhance.Contrast),
                     ("sat", ImageEnhance.Color)):
        f = rng.uniform(0.85, 1.15)
        img = Enh(img).enhance(f)
        desc.append(f"{nom}={f:.2f}")
    if rng.random() < 0.15:
        img = img.filter(ImageFilter.GaussianBlur(rng.uniform(0.3, 0.8)))
        desc.append("flou")

    # Noir et blanc : ajoute le mot-clé correspondant
    nb_tag = D.normaliser_tag(regles["noir_et_blanc_tag"])
    if nb_permis and nb_tag not in tags and rng.random() < regles["noir_et_blanc_proba"]:
        img = ImageOps.grayscale(img).convert("RGB")
        tags = sorted(set(tags) | {nb_tag})
        desc.append("noir et blanc")

    return img, tags, ",".join(desc)


def planche(images, chemin, n_col=8, taille=128):
    images = images[: n_col * 4]
    if not images:
        return
    rows = (len(images) + n_col - 1) // n_col
    sheet = Image.new("RGB", (n_col * taille, rows * taille), "white")
    for i, im in enumerate(images):
        sheet.paste(im.resize((taille, taille)), ((i % n_col) * taille, (i // n_col) * taille))
    sheet.save(chemin, quality=90)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", required=True, help="dossier des photos authentiques (avec etiquettes.json)")
    ap.add_argument("--sortie", required=True, help="dossier où écrire les variantes (créé)")
    ap.add_argument("--par-image", type=int, default=20, help="nombre d'images produites par photo (original compris)")
    ap.add_argument("--taille", type=int, default=256, help="côté des images produites, en pixels")
    ap.add_argument("--seulement-etiquetees", action="store_true", help="ignorer les photos sans mot-clé")
    ap.add_argument("--seulement-verifiees", action="store_true",
                    help="ignorer les photos pas encore validées dans etiqueter.py")
    ap.add_argument("--tout-refaire", action="store_true", help="régénérer toutes les variantes")
    ap.add_argument("--graine", type=int, default=0)
    args = ap.parse_args()

    src, out = Path(args.source), Path(args.sortie)
    if out.resolve() == src.resolve() or src.resolve() in out.resolve().parents:
        raise SystemExit("--sortie doit être un autre dossier que --source (et pas à l'intérieur)")
    etiquettes = D.charger_etiquettes(src)
    regles = D.charger_regles(src)
    fichiers = D.lister_images(src)
    if args.seulement_etiquetees:
        fichiers = [f for f in fichiers if etiquettes.get(f, {}).get("tags")]
    non_verifiees = [f for f in fichiers if not etiquettes.get(f, {}).get("verifie")]
    if args.seulement_verifiees:
        fichiers = [f for f in fichiers if f not in non_verifiees]
    elif non_verifiees:
        print(f"Attention : {len(non_verifiees)} photo(s) pas encore validées (leurs mots-clés proposés "
              f"automatiquement sont utilisés tels quels). --seulement-verifiees pour les ignorer.")
    if not fichiers:
        raise SystemExit("Aucune image à traiter.")

    out.mkdir(parents=True, exist_ok=True)
    precedentes = D.charger_etiquettes(out) if not args.tout_refaire else {}
    deja = {}  # photo source -> {nom de variante: entrée}
    for nom, e in precedentes.items():
        deja.setdefault(e.get("source"), {})[nom] = e

    def signature(rel, e):
        p = src / rel
        brut = json.dumps([e.get("tags", []), e.get("zone"), p.stat().st_mtime_ns, p.stat().st_size,
                           args.par_image, args.taille, args.graine, regles], sort_keys=True, ensure_ascii=False)
        return hashlib.sha1(brut.encode()).hexdigest()[:16]

    nouvelles, apercu = {}, []
    gardees = refaites = 0
    for i, rel in enumerate(fichiers, 1):
        e = etiquettes.get(rel, {})
        tags, zone = e.get("tags", []), e.get("zone")
        sig = signature(rel, e)
        anciennes = deja.pop(rel, {})
        if anciennes and all(v.get("signature") == sig and (out / n).exists() for n, v in anciennes.items()) \
                and len(anciennes) == args.par_image:
            nouvelles.update(anciennes)
            gardees += 1
            continue
        for n in anciennes:  # photo modifiée : on efface ses anciennes variantes
            (out / n).unlink(missing_ok=True)
        refaites += 1
        # graine propre à chaque photo : ses variantes ne dépendent pas des autres photos
        rng = random.Random(f"{args.graine}:{rel}")
        try:
            img = D.ouvrir(src / rel)
        except Exception as err:  # image illisible : on la saute sans tout arrêter
            print(f"  ! {rel} ignorée ({err})")
            continue
        stem = Path(rel).with_suffix("")
        (out / stem.parent).mkdir(parents=True, exist_ok=True)
        for k in range(args.par_image):
            if k == 0:  # l'original, simplement recadré en carré autour de la zone importante
                v, vt, desc = D.carre(img, zone), tags, "original"
            else:
                v, vt, desc = variante(img, tags, zone, regles, rng)
            v = v.resize((args.taille, args.taille), Image.LANCZOS)
            nom = f"{stem.as_posix()}_{k:03d}.jpg"
            v.save(out / nom, quality=95)
            nouvelles[nom] = {"tags": vt, "source": rel, "transformations": desc, "signature": sig}
            if len(apercu) < 32 and (k < 4):
                apercu.append(v)
        print(f"[{i}/{len(fichiers)}] {rel} -> {args.par_image} images")

    supprimees = 0
    for variantes in deja.values():  # photos retirées de la source (ou exclues) : on efface leurs variantes
        for n in variantes:
            (out / n).unlink(missing_ok=True)
            supprimees += 1

    D.sauver_json(out / D.FICHIER_ETIQUETTES, nouvelles)
    if (src / D.FICHIER_REGLES).exists():
        shutil.copy(src / D.FICHIER_REGLES, out / D.FICHIER_REGLES)
    if apercu:
        planche(apercu, out / "_apercu.jpg")
    print(f"\n{len(nouvelles)} images dans {out}/ : {refaites} photo(s) traitée(s), {gardees} inchangée(s), "
          f"{supprimees} variante(s) obsolète(s) effacée(s). Aperçu : {out / '_apercu.jpg'}")


if __name__ == "__main__":
    main()
