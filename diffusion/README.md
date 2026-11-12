# Modèle de diffusion entraîné depuis zéro

Un générateur d'images par diffusion (DDPM + échantillonnage DDIM) **totalement vierge** :
le réseau U-Net démarre avec des poids aléatoires, aucun modèle pré-entraîné n'est
téléchargé. Il n'apprend qu'à partir des images que vous lui donnez.

## Installation

```bash
cd diffusion
pip install -r requirements.txt
```

Un GPU NVIDIA (CUDA) est fortement recommandé. Ça tourne aussi sur Mac (MPS) et sur CPU,
mais le CPU est beaucoup trop lent pour un vrai entraînement.

## 1. Préparer vos images

Mettez vos images (jpg, png, webp…) dans un dossier. Elles sont redimensionnées et
recadrées au centre automatiquement.

**Sans classes** : tout dans un dossier (les sous-dossiers sont parcourus aussi).
```
mes_images/
  img001.jpg
  img002.png
  ...
```

**Avec classes** (pour pouvoir choisir ce qu'on génère) : un sous-dossier par classe.
```
mes_images/
  chats/   *.jpg
  chiens/  *.jpg
```

Combien d'images ? Quelques centaines au minimum pour un résultat reconnaissable, plusieurs
milliers d'images homogènes (même sujet, même cadrage) pour de bons résultats.

## 2. Entraîner

```bash
# Non conditionnel
python train.py --data mes_images --out runs/essai1

# Conditionnel par classe
python train.py --data mes_images --out runs/essai2 --conditional

# Reprendre après une interruption
python train.py --data mes_images --out runs/essai1 --resume
```

Pendant l'entraînement :
- la perte s'affiche toutes les 100 itérations ;
- une grille d'images générées est sauvegardée dans `runs/<nom>/samples/` toutes les
  2000 itérations : c'est là qu'on voit le modèle progresser (bruit → formes → images) ;
- le checkpoint `runs/<nom>/checkpoint.pt` est mis à jour toutes les 5000 itérations.

Options utiles :

| Option | Défaut | Rôle |
|---|---|---|
| `--image-size` | 64 | résolution (32, 64, 128… ; puissance de 2) |
| `--channels` | 3 | 1 pour des images en niveaux de gris |
| `--base-channels` | 64 | taille du modèle (32 = petit/rapide, 128 = gros) |
| `--batch-size` | 32 | baisser si manque de mémoire GPU |
| `--steps` | 100000 | nombre d'itérations d'entraînement |
| `--lr` | 2e-4 | taux d'apprentissage |

Ordres de grandeur : en 64×64 avec les réglages par défaut (~35 M paramètres), compter
quelques heures sur un GPU récent pour des résultats corrects. Pour un premier essai,
`--image-size 32 --base-channels 32` va beaucoup plus vite. En 128×128, ajoutez un niveau :
`--channel-mults 1,1,2,2,4`.

## 3. Générer des images

```bash
python sample.py --ckpt runs/essai1/checkpoint.pt --n 16 --out generees.png
python sample.py --ckpt runs/essai1/checkpoint.pt --n 50 --separate --out-dir images/
python sample.py --ckpt runs/essai2/checkpoint.pt --classe chats --guidance 4
```

- `--steps` : nombre de pas de débruitage (50–250). Plus = meilleure qualité, plus lent.
- `--guidance` : pour un modèle à classes, plus c'est haut, plus l'image colle à la classe
  (au prix de la diversité). 1 = pas de guidage.
- `--seed` : pour obtenir les mêmes images à chaque fois.

## Comment ça marche

- `model.py` — U-Net (blocs résiduels + attention) qui prend une image bruitée et le
  numéro d'étape de bruit, et prédit le bruit présent dans l'image.
- `diffusion.py` — à l'entraînement, on prend une de vos images, on y ajoute une quantité
  aléatoire de bruit gaussien (planning cosinus sur 1000 étapes), et le réseau apprend à
  retrouver ce bruit (perte MSE). Pour générer, on part de bruit pur et on le retire petit
  à petit (DDIM).
- `train.py` — boucle d'entraînement avec moyenne mobile des poids (EMA), précision mixte
  sur GPU, sauvegarde/reprise.
- `sample.py` — génération à partir d'un checkpoint.
