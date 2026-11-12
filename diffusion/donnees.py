"""Outils communs : étiquettes (mots-clés), règles de transformation, recadrage.

Fichiers placés à la racine du dossier d'images :

  etiquettes.json   { "photo1.jpg": {"tags": ["short", "lunettes"], "zone": [x0, y0, x1, y1]}, ... }
                    "zone" (facultatif) = partie de l'image à ne jamais couper, en
                    coordonnées relatives (0 à 1). Créé par etiqueter.py.

  regles.json       ce qu'on a le droit de faire à une image sans changer son sens
                    (voir REGLES_PAR_DEFAUT ci-dessous).

  vocabulaire.json  la liste des mots-clés proposés, rangés par catégorie (expression,
                    habits, météo…). Modifiable depuis etiqueter.py.

Une entrée de etiquettes.json peut aussi contenir :
  "auto"    : mots-clés proposés automatiquement, pas encore confirmés par vous
  "verifie" : true une fois que vous avez validé la photo dans etiqueter.py
"""
import json
import os
import re
from pathlib import Path

from PIL import Image

EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif", ".tif", ".tiff"}
FICHIER_ETIQUETTES = "etiquettes.json"
FICHIER_REGLES = "regles.json"
FICHIER_VOCABULAIRE = "vocabulaire.json"

REGLES_PAR_DEFAUT = {
    "_aide": {
        "miroir_echange": "mots inversés quand l'image est retournée gauche/droite. "
                          "Marche aussi à l'intérieur d'un mot-clé : 'main droite levée' -> 'main gauche levée'",
        "miroir_interdit": "si l'image a un de ces mots-clés, elle n'est jamais retournée (ex : du texte deviendrait illisible)",
        "recadrage_interdit": "si l'image a un de ces mots-clés, elle est très peu recadrée (scène à voir en entier, ou position dans l'image qui compte)",
        "recadrage_min": "taille minimale du recadrage, en fraction du côté de l'image (1 = pas de recadrage)",
        "rotation_max": "rotation maximale en degrés",
        "noir_et_blanc_proba": "probabilité de créer une variante en noir et blanc (le mot-clé ci-dessous est alors ajouté)",
        "noir_et_blanc_tag": "mot-clé ajouté aux variantes en noir et blanc",
    },
    "miroir_echange": [["droite", "gauche"], ["droit", "gauche"]],
    "miroir_interdit": ["texte", "écriture", "logo"],
    "recadrage_interdit": ["en entier", "plan large", "à droite", "à gauche"],
    "recadrage_min": 0.7,
    "rotation_max": 6,
    "noir_et_blanc_proba": 0.1,
    "noir_et_blanc_tag": "noir et blanc",
}


# --------------------------------------------------------------------- fichiers
def lister_images(racine):
    racine = Path(racine)
    return sorted(p.relative_to(racine).as_posix() for p in racine.rglob("*")
                  if p.suffix.lower() in EXTS and p.is_file() and not p.name.startswith("_"))


def normaliser_tag(tag: str) -> str:
    return re.sub(r"[\s_]+", " ", tag.strip().lower())


def charger_etiquettes(racine) -> dict:
    f = Path(racine) / FICHIER_ETIQUETTES
    if not f.exists():
        return {}
    data = json.loads(f.read_text(encoding="utf-8"))
    out = {}
    for nom, e in data.items():
        if isinstance(e, list):  # format simplifié accepté : "photo.jpg": ["short", ...]
            e = {"tags": e}
        e = dict(e)
        e["tags"] = sorted({normaliser_tag(t) for t in e.get("tags", []) if t.strip()})
        if "auto" in e:
            e["auto"] = sorted({normaliser_tag(t) for t in e["auto"] if t.strip()} & set(e["tags"]))
        out[nom] = e
    return out


def sauver_json(chemin, data):
    chemin = Path(chemin)
    tmp = chemin.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    os.replace(tmp, chemin)  # écriture atomique : pas de fichier corrompu si on coupe au mauvais moment


def charger_regles(racine, creer=False) -> dict:
    f = Path(racine) / FICHIER_REGLES
    regles = json.loads(json.dumps(REGLES_PAR_DEFAUT))
    if f.exists():
        regles.update(json.loads(f.read_text(encoding="utf-8")))
    elif creer:
        sauver_json(f, regles)
    regles["miroir_interdit"] = [normaliser_tag(t) for t in regles["miroir_interdit"]]
    regles["recadrage_interdit"] = [normaliser_tag(t) for t in regles["recadrage_interdit"]]
    return regles


# ------------------------------------------------------------------ vocabulaire
# "seance": true = en général identique pour toutes les photos d'une même séance
# (même jour, même tenue, même lieu) ; sert à proposer des mots-clés automatiquement.
VOCABULAIRE_PAR_DEFAUT = {"categories": [
    {"nom": "Expression", "seance": False, "tags": [
        "sourire", "rire", "sérieux", "neutre", "grimace", "bouche ouverte", "langue tirée", "yeux fermés",
        "clin d'œil", "surpris", "sourcils froncés"]},
    {"nom": "Humeur", "seance": False, "tags": [
        "joyeux", "détendu", "calme", "concentré", "pensif", "fatigué", "énervé", "triste", "fier"]},
    {"nom": "Pose", "seance": False, "tags": [
        "de face", "de trois quarts", "de profil", "de dos", "debout", "assis", "allongé", "accroupi",
        "bras croisés", "bras levés", "mains sur les hanches", "main au visage", "pouce levé", "en mouvement",
        "pose bizarre", "regard caméra", "regard ailleurs"]},
    {"nom": "Cadrage", "seance": False, "tags": [
        "gros plan", "plan poitrine", "plan moyen", "en entier", "plan large", "selfie", "à gauche",
        "au centre", "à droite", "vu d'en haut", "vu d'en bas"]},
    {"nom": "Habits", "seance": True, "tags": [
        "t-shirt", "chemise", "pull", "sweat à capuche", "veste", "manteau", "costume", "cravate",
        "short", "jean", "pantalon", "jogging", "robe", "jupe", "maillot de bain", "tenue de sport",
        "pyjama", "baskets", "chaussures de ville", "pieds nus"]},
    {"nom": "Accessoires", "seance": True, "tags": [
        "lunettes", "lunettes de soleil", "casquette", "bonnet", "chapeau", "capuche mise", "écharpe",
        "montre", "bijoux", "sac", "casque audio", "écouteurs", "téléphone en main"]},
    {"nom": "Cheveux et visage", "seance": True, "tags": [
        "cheveux attachés", "cheveux détachés", "cheveux mouillés", "décoiffé", "barbe", "rasé",
        "maquillage"]},
    {"nom": "Lieu et contexte", "seance": True, "tags": [
        "intérieur", "extérieur", "maison", "chambre", "cuisine", "bureau", "professionnel", "école",
        "rue", "ville", "nature", "forêt", "plage", "montagne", "jardin", "voiture", "transports",
        "restaurant", "soirée", "fête", "sport", "vacances", "concert"]},
    {"nom": "Météo et lumière", "seance": True, "tags": [
        "soleil", "nuageux", "pluie", "neige", "brouillard", "vent", "nuit", "coucher de soleil",
        "contre-jour", "lumière artificielle", "sombre", "lumineux", "flash"]},
    {"nom": "Saison", "seance": True, "tags": ["printemps", "été", "automne", "hiver"]},
    {"nom": "Technique", "seance": False, "tags": [
        "noir et blanc", "flou", "photo ancienne", "visage visible", "seul", "plusieurs personnes",
        "texte visible", "miroir"]},
    {"nom": "Autres", "seance": False, "tags": []},
]}


def charger_vocabulaire(racine, creer=False) -> dict:
    f = Path(racine) / FICHIER_VOCABULAIRE
    if f.exists():
        voc = json.loads(f.read_text(encoding="utf-8"))
    else:
        voc = json.loads(json.dumps(VOCABULAIRE_PAR_DEFAUT))
        if creer:
            sauver_json(f, voc)
    for c in voc["categories"]:
        vus, tags = set(), []
        for t in map(normaliser_tag, c.get("tags", [])):
            if t and t not in vus:
                vus.add(t)
                tags.append(t)
        c["tags"] = tags
        c.setdefault("seance", False)
    if not any(c["nom"] == "Autres" for c in voc["categories"]):
        voc["categories"].append({"nom": "Autres", "seance": False, "tags": []})
    return voc


def categorie_de(voc) -> dict:
    """tag -> catégorie"""
    return {t: c for c in voc["categories"] for t in c["tags"]}


# ----------------------------------------------------------------------- miroir
def _contient_mot(tag, mot):
    return re.search(r"(?<![^\W_])" + re.escape(mot) + r"(?![^\W_])", tag) is not None


def tags_miroir(tags, regles):
    """Mots-clés après un retournement gauche/droite, ou None si le retournement est interdit."""
    for interdit in regles["miroir_interdit"]:
        if any(_contient_mot(t, interdit) for t in tags):
            return None
    paires = {}
    for a, b in regles["miroir_echange"]:
        a, b = normaliser_tag(a), normaliser_tag(b)
        paires.setdefault(a, b)
        paires.setdefault(b, a)
    if not paires:
        return list(tags)
    motif = re.compile(r"(?<![^\W_])(" + "|".join(sorted(map(re.escape, paires), key=len, reverse=True)) + r")(?![^\W_])")
    return sorted({motif.sub(lambda m: paires[m.group(1)], t) for t in tags})


def zone_miroir(zone):
    if zone is None:
        return None
    x0, y0, x1, y1 = zone
    return [1 - x1, y0, 1 - x0, y1]


def recadrage_interdit(tags, regles):
    return any(_contient_mot(t, r) for t in tags for r in regles["recadrage_interdit"])


# ------------------------------------------------------------------- recadrage
def couleur_moyenne(img):
    return tuple(int(c) for c in img.resize((1, 1), Image.BILINEAR).getpixel((0, 0)))


def carre(img, zone=None, echelle=1.0, rng=None):
    """Recadre en carré en gardant toujours la `zone` entière.

    echelle : côté du carré en fraction du petit côté de l'image (1 = le plus grand carré possible).
    rng     : si fourni, position aléatoire ; sinon carré centré sur la zone (ou l'image).
    """
    W, H = img.size
    z = [zone[0] * W, zone[1] * H, zone[2] * W, zone[3] * H] if zone else None
    cote = echelle * min(W, H)
    if z:
        cote = max(cote, z[2] - z[0], z[3] - z[1])

    if cote > min(W, H):
        # La zone importante ne tient pas dans un carré de l'image : on ajoute des bandes au lieu de couper
        S = max(W, H)
        fond = Image.new(img.mode, (S, S), couleur_moyenne(img))
        ox, oy = (S - W) // 2, (S - H) // 2
        fond.paste(img, (ox, oy))
        img, W, H = fond, S, S
        z = [z[0] + ox, z[1] + oy, z[2] + ox, z[3] + oy]

    # Positions du coin haut-gauche pour lesquelles la zone reste dans le carré
    if z:
        xmin, xmax = max(0, z[2] - cote), min(W - cote, z[0])
        ymin, ymax = max(0, z[3] - cote), min(H - cote, z[1])
        cx, cy = (z[0] + z[2]) / 2, (z[1] + z[3]) / 2
    else:
        xmin, xmax, ymin, ymax = 0, W - cote, 0, H - cote
        cx, cy = W / 2, H / 2
    if rng is None:
        x = min(max(cx - cote / 2, xmin), xmax)
        y = min(max(cy - cote / 2, ymin), ymax)
    else:
        x, y = rng.uniform(xmin, xmax), rng.uniform(ymin, ymax)
    return img.crop((round(x), round(y), round(x + cote), round(y + cote)))


def ouvrir(chemin, mode="RGB"):
    from PIL import ImageOps
    img = Image.open(chemin)
    img = ImageOps.exif_transpose(img)  # respecte l'orientation des photos de téléphone
    return img.convert(mode)

