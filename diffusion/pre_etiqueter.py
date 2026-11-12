"""Propose automatiquement une base de mots-clés, à vérifier ensuite dans etiqueter.py.

    python pre_etiqueter.py mes_photos            # analyse les photos pas encore vérifiées
    python pre_etiqueter.py mes_photos --sans-visages

Aucun modèle d'IA entraîné sur les images d'autres personnes n'est utilisé. Les propositions
viennent de quatre sources simples :

1. Mesures sur l'image : noir et blanc, sombre, lumineux, flou.
2. Informations de la photo (EXIF) : saison (d'après le mois, hémisphère nord), nuit
   (d'après l'heure et la luminosité), flash, selfie (caméra avant du téléphone).
3. Détection de visages « classique » d'OpenCV (méthode de Viola-Jones, 2001 : pas de
   réseau de neurones ; facultative, nécessite `pip install "opencv-python-headless<5"`) :
   visage visible, de face/de profil, seul/plusieurs personnes, cadrage (gros plan…),
   position (à gauche/au centre/à droite), et une zone importante autour du visage.
4. Vos propres photos déjà vérifiées :
   - même séance (photos prises à moins de 45 min d'intervalle) : on propose les habits,
     accessoires, lieu, météo… que vous avez mis sur les autres photos de la séance ;
   - photo quasi identique (rafale, images de vidéo) : on propose tous ses mots-clés.
   Plus vous vérifiez de photos, meilleures sont les propositions pour les suivantes.

Les mots-clés proposés sont marqués « auto » jusqu'à ce que vous validiez la photo. Un mot-clé
que vous avez décoché n'est plus jamais reproposé pour cette photo.
"""
import argparse
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image

import donnees as D

try:
    import cv2
    _CASCADES = None
except ImportError:  # la détection de visages est facultative
    cv2 = None

ECART_SEANCE_MIN = 45        # deux photos à moins de 45 min = même séance
SEUIL_QUASI_IDENTIQUE = 0.95  # similarité (0 à 1) au-dessus de laquelle deux photos sont "presque les mêmes"

# Mots-clés calculés sur chaque photo elle-même : jamais recopiés depuis une autre photo
MESURES = {"noir et blanc", "sombre", "lumineux", "flou", "nuit", "flash", "selfie",
           "printemps", "été", "automne", "hiver"}
# Mots-clés incompatibles entre eux : on n'en propose pas un si un autre du groupe est déjà là
EXCLUSIFS = [
    {"printemps", "été", "automne", "hiver"},
    {"sombre", "lumineux"},
    {"gros plan", "plan poitrine", "plan moyen", "en entier", "plan large"},
    {"à gauche", "au centre", "à droite"},
    {"de face", "de trois quarts", "de profil", "de dos"},
    {"seul", "plusieurs personnes"},
    {"intérieur", "extérieur"},
    {"debout", "assis", "allongé", "accroupi"},
]


def ajouter_compatibles(props, candidats, deja=()):
    """Ajoute à props les candidats qui ne contredisent pas props ni `deja` (mots-clés déjà présents)."""
    presents = set(props) | set(deja)
    for t in candidats:
        if any(t in g and (presents & g) - {t} for g in EXCLUSIFS):
            continue
        props.add(t)
        presents.add(t)


# ---------------------------------------------------------------- mesures image
def mesures(img):
    """Luminosité, saturation, netteté et empreinte de similarité d'une image RGB."""
    petit = img.copy()
    petit.thumbnail((512, 512))
    hsv = np.asarray(petit.convert("HSV"), dtype=np.float32) / 255
    gris = np.asarray(petit.convert("L"), dtype=np.float32)
    lap = (-4 * gris[1:-1, 1:-1] + gris[:-2, 1:-1] + gris[2:, 1:-1] + gris[1:-1, :-2] + gris[1:-1, 2:])
    emp = np.asarray(img.resize((24, 24), Image.BILINEAR), dtype=np.float32).ravel()
    emp -= emp.mean()
    emp /= np.linalg.norm(emp) + 1e-6
    return {"lum": float(hsv[..., 2].mean()), "sat": float(hsv[..., 1].mean()),
            "nettete": float(lap.var()), "empreinte": emp}


def exif(chemin):
    out = {}
    try:
        e = Image.open(chemin).getexif()
        ifd = e.get_ifd(0x8769)  # bloc EXIF détaillé
        date = ifd.get(36867) or e.get(306)  # DateTimeOriginal, sinon DateTime
        if date:
            out["date"] = datetime.strptime(str(date).strip()[:19], "%Y:%m:%d %H:%M:%S")
        if 37385 in ifd:
            out["flash"] = bool(int(ifd[37385]) & 1)
        lens = str(ifd.get(42036, "")).lower()
        out["avant"] = "front" in lens or "avant" in lens
    except Exception:
        pass
    return out


def saison(mois):
    return {12: "hiver", 1: "hiver", 2: "hiver", 3: "printemps", 4: "printemps", 5: "printemps",
            6: "été", 7: "été", 8: "été"}.get(mois, "automne")


# --------------------------------------------------------------------- visages
def _cascades():
    global _CASCADES
    if _CASCADES is None:
        d = cv2.data.haarcascades
        _CASCADES = (cv2.CascadeClassifier(d + "haarcascade_frontalface_default.xml"),
                     cv2.CascadeClassifier(d + "haarcascade_profileface.xml"))
        if _CASCADES[0].empty():
            raise RuntimeError("Détecteur de visages introuvable : installez opencv-python-headless<5")
    return _CASCADES


def _fusion(boites):
    """Supprime les détections qui se chevauchent (on garde la plus grande)."""
    boites = sorted(boites, key=lambda b: -b[2] * b[3])
    gardees = []
    for b in boites:
        x, y, w, h, _ = b
        ok = True
        for g in gardees:
            ix = max(0, min(x + w, g[0] + g[2]) - max(x, g[0]))
            iy = max(0, min(y + h, g[1] + g[3]) - max(y, g[1]))
            if ix * iy > 0.3 * min(w * h, g[2] * g[3]):
                ok = False
                break
        if ok:
            gardees.append(b)
    return gardees


def visages(img):
    """Liste de (x, y, w, h, 'face' | 'profil') en pixels."""
    face, profil = _cascades()
    petit = img.copy()
    petit.thumbnail((1280, 1280))  # assez grand pour trouver les petits visages (plans larges)
    k = img.width / petit.width
    g = cv2.equalizeHist(np.asarray(petit.convert("L")))
    mini = max(20, int(0.03 * min(g.shape)))
    boites = [(*b, "face") for b in face.detectMultiScale(g, 1.1, 6, minSize=(mini, mini))]
    boites += [(*b, "profil") for b in profil.detectMultiScale(g, 1.1, 7, minSize=(mini, mini))]
    gm = np.ascontiguousarray(g[:, ::-1])  # le détecteur de profil ne voit qu'un côté : on teste aussi en miroir
    boites += [(g.shape[1] - x - w, y, w, h, "profil") for x, y, w, h in profil.detectMultiScale(gm, 1.1, 7, minSize=(mini, mini))]
    return [(x * k, y * k, w * k, h * k, t) for x, y, w, h, t in _fusion(boites)]


def tags_visages(taille, boites):
    W, H = taille
    if not boites:
        return [], None
    x, y, w, h, sorte = boites[0]  # le plus grand visage
    tags = ["visage visible", "de face" if sorte == "face" else "de profil",
            "plusieurs personnes" if len(boites) > 1 else "seul"]
    r = h / H
    tags.append("gros plan" if r > 0.35 else "plan poitrine" if r > 0.17 else "plan moyen" if r > 0.08 else "plan large")
    cx = (x + w / 2) / W
    tags.append("à gauche" if cx < 0.38 else "à droite" if cx > 0.62 else "au centre")
    # zone importante proposée : le visage avec de la marge (cou, cheveux)
    m = 0.5
    zone = [max(0, (x - m * w) / W), max(0, (y - m * h) / H), min(1, (x + w + m * w) / W), min(1, (y + h + 1.2 * m * h) / H)]
    return tags, [round(v, 3) for v in zone]


# ---------------------------------------------------------------- propositions
def proposer(racine, etiquettes, voc, avec_visages=True, journal=print):
    """Met à jour `etiquettes` (en place) avec des propositions pour les photos non vérifiées."""
    racine = Path(racine)
    fichiers = D.lister_images(racine)
    cat = D.categorie_de(voc)
    tags_seance = {t for c in voc["categories"] if c["seance"] for t in c["tags"]}
    if avec_visages and cv2 is None:
        journal("Détection de visages désactivée (OpenCV non installé : pip install \"opencv-python-headless<5\")")
        avec_visages = False

    infos = {}
    for n, f in enumerate(fichiers, 1):
        try:
            img = D.ouvrir(racine / f)
        except Exception as err:
            journal(f"  ! {f} illisible ({err})")
            continue
        i = mesures(img)
        i.update(exif(racine / f))
        e = etiquettes.get(f, {})
        if not e.get("verifie"):
            i["visages"] = visages(img) if avec_visages else []
            i["taille"] = img.size
        infos[f] = i
        if n % 25 == 0:
            journal(f"  analyse {n}/{len(fichiers)}")

    verifiees = [f for f in infos if etiquettes.get(f, {}).get("verifie")]

    # Séances : photos triées par date, coupées quand l'écart dépasse ECART_SEANCE_MIN
    seance, num, prec = {}, 0, None
    for f in sorted((f for f in infos if "date" in infos[f]), key=lambda f: infos[f]["date"]):
        d = infos[f]["date"]
        if prec is None or (d - prec).total_seconds() > ECART_SEANCE_MIN * 60:
            num += 1
        seance[f], prec = num, d

    nb_modifiees = 0
    for f, i in infos.items():
        e = etiquettes.setdefault(f, {"tags": []})
        if e.get("verifie"):
            continue
        props = set()
        # 1. mesures
        if i["sat"] < 0.04:
            props.add("noir et blanc")
        if i["lum"] < 0.28:
            props.add("sombre")
        elif i["lum"] > 0.75:
            props.add("lumineux")
        if i["nettete"] < 25:
            props.add("flou")
        # 2. EXIF
        if "date" in i:
            props.add(saison(i["date"].month))
            if (i["date"].hour >= 21 or i["date"].hour < 6) and i["lum"] < 0.4:
                props.add("nuit")
        if i.get("flash"):
            props.add("flash")
        if i.get("avant"):
            props.add("selfie")
        # 3. visages
        zone_auto = None
        if i.get("visages") is not None:
            tv, zone_auto = tags_visages(i["taille"], i["visages"])
            props.update(tv)
        # 4. vos photos vérifiées : même séance...
        if f in seance:
            soeurs = [v for v in verifiees if seance.get(v) == seance[f]]
            if soeurs:
                compte = {}
                for v in soeurs:
                    for t in etiquettes[v]["tags"]:
                        if t in tags_seance:
                            compte[t] = compte.get(t, 0) + 1
                ajouter_compatibles(props, [t for t, n in compte.items() if n >= max(1, len(soeurs) / 2)],
                                    set(e["tags"]) - set(e.get("auto", [])))
        # ... et photo quasi identique
        if verifiees:
            sims = [(float(i["empreinte"] @ infos[v]["empreinte"]), v) for v in verifiees]
            s, v = max(sims)
            if s >= SEUIL_QUASI_IDENTIQUE:
                ajouter_compatibles(props, [t for t in etiquettes[v]["tags"] if t not in MESURES],
                                    set(e["tags"]) - set(e.get("auto", [])))
                if not zone_auto and etiquettes[v].get("zone"):
                    zone_auto = etiquettes[v]["zone"]

        props -= set(e.get("refuse", []))
        anciens_auto = set(e.get("auto", []))
        manuels = set(e["tags"]) - anciens_auto
        nouveaux = manuels | props
        if nouveaux != set(e["tags"]) or (zone_auto and not e.get("zone")):
            nb_modifiees += 1
        e["tags"] = sorted(nouveaux)
        e["auto"] = sorted(props - manuels)
        if zone_auto and (not e.get("zone") or e.get("zone_auto")):
            e["zone"], e["zone_auto"] = zone_auto, True

    # Les mots-clés proposés qui ne sont dans aucune catégorie vont dans "Autres"
    autres = next(c for c in voc["categories"] if c["nom"] == "Autres")
    for e in etiquettes.values():
        for t in e.get("tags", []):
            if t not in cat:
                autres["tags"].append(t)
                cat[t] = autres
    return nb_modifiees


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dossier")
    ap.add_argument("--sans-visages", action="store_true", help="ne pas utiliser la détection de visages")
    args = ap.parse_args()
    racine = Path(args.dossier)
    etiq = D.charger_etiquettes(racine)
    voc = D.charger_vocabulaire(racine, creer=True)
    n = proposer(racine, etiq, voc, avec_visages=not args.sans_visages)
    D.sauver_json(racine / D.FICHIER_ETIQUETTES, etiq)
    D.sauver_json(racine / D.FICHIER_VOCABULAIRE, voc)
    print(f"{n} photos ont reçu des propositions. Vérifiez-les avec : python etiqueter.py {args.dossier}")


if __name__ == "__main__":
    main()
