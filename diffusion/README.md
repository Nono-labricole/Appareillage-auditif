# Générateur d'images entraîné uniquement sur vos propres photos

Un générateur d'images par diffusion **totalement vierge** : le réseau démarre avec des poids
aléatoires et n'apprend qu'à partir de vos photos. Aucun modèle pré-entraîné n'est utilisé à
aucune étape, ni pour générer, ni pour multiplier les photos, ni pour comprendre les mots-clés.

```
 vos photos ──► etiqueter.py ──────────────► augmenter.py ──► train.py ──► sample.py
 (authentiques)  1. propose des mots-clés     variantes        entraînement   génération
                 2. vous vérifiez/complétez   (miroir, cadre…)  depuis zéro    avec mots-clés
```

**Ajouter des photos plus tard** : déposez-les dans le dossier, puis relancez les trois mêmes
commandes. `etiqueter.py` analyse seulement les nouvelles photos, `augmenter.py` ne refait que ce
qui a changé, et `train.py --resume --steps <plus>` continue l'entraînement, même s'il y a de
nouveaux mots-clés.

## Installation

```bash
cd diffusion
pip install -r requirements.txt
```

Un GPU NVIDIA (CUDA) est fortement recommandé (sinon : Google Colab, GPU gratuit). Ça tourne aussi
sur Mac (MPS) et sur CPU, mais le CPU est beaucoup trop lent pour un vrai entraînement.

## 1. Mots-clés : proposition automatique, puis vérification

```bash
python etiqueter.py mes_photos
```

**Au démarrage**, les nouvelles photos du dossier sont analysées et reçoivent une base de mots-clés
(aussi lançable seule : `python pre_etiqueter.py mes_photos`). **Aucun modèle d'IA** entraîné sur
les photos d'autres personnes n'est utilisé. Les propositions viennent de quatre sources :

| Source | Mots-clés proposés |
|---|---|
| Mesures sur l'image | noir et blanc, sombre, lumineux, flou |
| Infos de la photo (date, appareil) | saison (hémisphère nord), nuit, flash, selfie (caméra avant) |
| Détection de visages « classique » d'OpenCV (méthode de 2001, sans réseau de neurones ; facultative, `--sans-visages` pour la couper) | visage visible, de face / de profil, seul / plusieurs personnes, gros plan / plan poitrine / plan moyen / plan large, à gauche / au centre / à droite, et une zone importante autour du visage |
| **Vos photos déjà validées** | photos de la **même séance** (prises à moins de 45 min d'intervalle) : vos habits, accessoires, coiffure, lieu, météo… ; photo **quasi identique** (rafale, vidéo) : tous ses mots-clés |

Les expressions, humeurs, poses, habits et lieux ne peuvent pas être devinés sans IA. Ce sont donc
les photos que vous validez qui permettent de les proposer pour les suivantes. Bouton
**« Proposer à nouveau »** : relance les propositions en tenant compte de vos dernières validations.
Plus vous validez, moins il reste à cocher.

Une page s'ouvre ensuite dans votre navigateur. Elle tourne **uniquement sur votre ordinateur**.

- Les mots-clés sont **rangés par catégorie** : expression, humeur, pose, cadrage, habits,
  accessoires, cheveux et visage, lieu et contexte, météo et lumière, saison, technique.
  Il y a environ 140 mots-clés au départ (`vocabulaire.json`).
- **En pointillés orange** : proposé automatiquement. **En bleu** : coché. Cliquez pour cocher ou
  décocher. Un mot-clé proposé que vous décochez ne sera plus jamais reproposé pour cette photo.
- **Ajouter un mot-clé** : tapez-le, choisissez sa catégorie, Entrée. Il devient cochable pour
  toutes les photos. Taper un mot-clé existant le coche, et la saisie filtre la liste.
- **Modifier la liste** (en bas) : en mode édition, cliquer sur un mot-clé permet de le
  renommer sur toutes les photos, de le changer de catégorie ou de le supprimer.
- **Zone importante** : tracez à la souris ce qui ne doit jamais être coupé par les recadrages.
  Elle est proposée automatiquement autour du visage.
- **« ✓ Valider et suivante »** (ou Entrée dans le champ vide) confirme la photo. Le menu en haut
  filtre les photos à vérifier, déjà vérifiées, ou toutes. Autres raccourcis : Alt+← / Alt+→,
  Alt+C = copier les mots-clés de la photo précédente.

Tout est enregistré au fur et à mesure (`etiquettes.json`, `vocabulaire.json`). On peut s'arrêter
et reprendre plus tard.

**Conseils**
- Un mot-clé a besoin d'au moins 20 images environ pour être appris (variantes comprises).
  `train.py` vous prévient sinon. Mieux vaut moins de mots-clés, bien appliqués, que beaucoup
  utilisés au hasard.
- Si une photo n'a pas de lunettes, ne pas cocher « lunettes » suffit : le modèle apprend la
  différence entre les photos qui l'ont et celles qui ne l'ont pas. Encore faut-il le cocher sur
  **toutes** les photos où il y en a.

## 2. Multiplier vos photos (sans IA)

```bash
python augmenter.py --source mes_photos --sortie mes_photos_x20 --par-image 20
```

Relancer la même commande après des modifications ne refait que les photos ajoutées ou dont les
mots-clés ou la zone ont changé, et efface les variantes des photos supprimées.
`--seulement-verifiees` ignore les photos pas encore validées.

Chaque photo authentique donne 20 images : l'original, plus 19 variantes tirées au hasard parmi
ces transformations :
- miroir gauche/droite ;
- recadrage (jusqu'à 70 % du côté par défaut) ;
- petite rotation (±6°) ;
- lumière, contraste et saturation (±15 %) ;
- léger flou ;
- noir et blanc.

**Le sens est préservé grâce à `regles.json`** (créé automatiquement dans le dossier des photos,
modifiable avec n'importe quel éditeur de texte) :

| Règle | Défaut | Effet |
|---|---|---|
| `miroir_echange` | droite ↔ gauche | quand une photo est retournée, « à droite » devient « à gauche », « main droite levée » devient « main gauche levée », etc. |
| `miroir_interdit` | texte, écriture, logo | une photo avec ce mot-clé n'est jamais retournée (le texte serait à l'envers) |
| `recadrage_interdit` | en entier, plan large, à droite, à gauche | une photo avec ce mot-clé est à peine recadrée (on doit voir la scène entière, ou la position dans l'image compte) |
| `recadrage_min` | 0.7 | recadrage maximal pour les autres photos |
| `rotation_max` | 6 | rotation maximale en degrés |
| `noir_et_blanc_proba` | 0.1 | une variante sur 10 en noir et blanc, avec le mot-clé `noir et blanc` ajouté |

Exemple : si un de vos tatouages ou une raie dans les cheveux ne doit pas changer de côté, ajoutez
`tatouage` à `miroir_interdit`.

La zone importante n'est **jamais coupée**. Le fichier `_apercu.jpg` dans le dossier de sortie
montre un échantillon des variantes pour vérifier d'un coup d'œil. Le fichier `etiquettes.json`
de sortie indique pour chaque variante sa photo d'origine et les transformations appliquées.

**À savoir** : les variantes réduisent le « par cœur » et apprennent au modèle que vous restez
vous-même en miroir, recadré ou sous une autre lumière. Elles ne créent pas de nouvelles poses
ni de nouveaux lieux : la vraie variété vient de vos photos d'origine. Vos anciennes photos, très
variées, sont donc précieuses.

## 3. Entraîner

```bash
python train.py --data mes_photos_x20 --out runs/moi
```

Le fichier `etiquettes.json` du dossier est utilisé automatiquement. Pendant l'entraînement :
- la perte s'affiche toutes les 100 itérations, avec la liste des mots-clés et leur nombre d'images ;
- une grille d'images générées est enregistrée dans `runs/moi/samples/` toutes les 2000
  itérations : c'est là qu'on voit le modèle progresser (bruit → formes → images) ;
- `runs/moi/checkpoint.pt` est mis à jour toutes les 5000 itérations. `--resume` reprend
  l'entraînement après une interruption, ou le continue après ajout de photos (avec un `--steps`
  plus grand). Les nouveaux mots-clés sont ajoutés au modèle sans perdre ce qu'il a déjà appris.

| Option | Défaut | Rôle |
|---|---|---|
| `--image-size` | 64 | résolution (32, 64, 128… ; puissance de 2) |
| `--base-channels` | 64 | taille du modèle (32 = petit/rapide, 128 = gros) |
| `--batch-size` | 32 | baisser si manque de mémoire GPU |
| `--steps` | 100000 | nombre d'itérations d'entraînement |
| `--sans-tags` | | ignorer les mots-clés |
| `--sans-miroir` | | pas de miroir pendant l'entraînement (par défaut il y en a, avec les mêmes règles) |
| `--dossiers-comme-tags` | | le nom du sous-dossier devient un mot-clé |

Pour un premier essai rapide : `--image-size 32 --base-channels 32`. En 128×128 :
`--channel-mults 1,1,2,2,4`.

## 4. Générer

```bash
python sample.py --ckpt runs/moi/checkpoint.pt --liste-tags
python sample.py --ckpt runs/moi/checkpoint.pt --tags "short, lunettes" --n 16
python sample.py --ckpt runs/moi/checkpoint.pt --tags "plan large" --sans "lunettes"
python sample.py --ckpt runs/moi/checkpoint.pt --n 50 --separate --out-dir images/
```

- `--tags` : ce que vous voulez. Les mots-clés non donnés sont laissés au choix du modèle.
- `--sans` : ce que vous ne voulez pas (« prompt négatif »).
- `--guidance` : à quel point respecter les mots-clés (3 à 5 conseillé ; plus haut = plus fidèle
  mais moins varié).
- `--steps` : pas de débruitage (50 à 250 ; plus = meilleur mais plus lent). `--seed` : résultat
  reproductible.

## Ce qu'il faut attendre

- Avec ~100 photos, le modèle aura tendance à **recopier** vos photos (même avec les variantes).
  Il commence à inventer de vraies nouvelles images à partir de quelques milliers d'images
  différentes. Les vidéos découpées en images sont un bon moyen d'en avoir beaucoup.
- Les mots-clés ne sont pas du langage : le modèle apprend seulement ce que chaque mot-clé change
  dans l'image. Il peut combiner des mots-clés jamais vus ensemble, avec plus ou moins de succès.

## Les fichiers

- `etiqueter.py` : logiciel d'étiquetage (page web locale).
- `pre_etiqueter.py` : propositions automatiques de mots-clés (sans IA).
- `augmenter.py` : multiplication des photos en respectant leur sens.
- `donnees.py` : lecture des mots-clés, vocabulaire par défaut, règles, recadrage qui garde la
  zone importante.
- `model.py` : U-Net qui prend une image bruitée, le niveau de bruit et les mots-clés, et prédit
  le bruit.
- `diffusion.py` : ajout de bruit (planning cosinus sur 1000 étapes), perte, génération (DDIM)
  avec guidage par mots-clés (classifier-free guidance) et prompt négatif.
- `train.py` : entraînement (EMA, précision mixte sur GPU, sauvegarde/reprise).
- `sample.py` : génération.
