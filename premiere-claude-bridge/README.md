# Claude Bridge pour Premiere Pro

Plugin **100 % local** qui permet à Claude (Claude Desktop ou Claude Code) de piloter Adobe Premiere Pro.
Pas de compte, pas de connexion, pas de dépendance à télécharger : tout passe par `127.0.0.1` sur votre machine.

```
Claude ──(MCP, stdio)──> mcp-server/index.js ──(HTTP 127.0.0.1 + jeton)──> panneau CEP dans Premiere ──> ExtendScript
```

- `extension/` : panneau Premiere (CEP). Il ouvre un mini-serveur HTTP sur `127.0.0.1:17830` et exécute les commandes via l'API de scripting de Premiere (`jsx/host.jsx`).
- `mcp-server/` : serveur MCP en Node.js **sans aucune dépendance npm**, lancé par Claude.
- Sécurité : le serveur n'écoute que sur la boucle locale et exige un jeton aléatoire stocké dans `~/.premiere-claude-bridge/bridge.json` (lisible seulement par votre compte).

## Prérequis

- Premiere Pro 2020 (14.x) ou plus récent (testé pour la famille CEP 9 à 12, Premiere 2024–2026).
- Node.js 18+ (seulement pour le serveur MCP).
- Claude Desktop ou Claude Code.

## Installation

**Windows** : double-cliquez sur `install\install-windows.bat`.
**macOS** : `bash install/install-macos.sh`.

Le script :
1. copie `extension/` dans le dossier des extensions CEP de votre utilisateur ;
2. active `PlayerDebugMode` (nécessaire pour une extension maison non signée — aucun droit admin requis) ;
3. ajoute le serveur `premiere` à la config de Claude Desktop (sauvegarde `.bak` de l'ancienne).

Puis :
1. redémarrez Premiere Pro, ouvrez un projet ;
2. **Fenêtre > Extensions > Claude Bridge** — le voyant doit passer au vert (« En écoute sur 127.0.0.1:17830 »). Gardez ce panneau ouvert (ancrez-le dans votre espace de travail, Premiere s'en souviendra) ;
3. redémarrez Claude Desktop. Demandez par exemple : *« Liste les séquences de mon projet Premiere »*.

**Claude Code** :
```
claude mcp add premiere -- node /chemin/vers/premiere-claude-bridge/mcp-server/index.js
```

### Installation manuelle (si les scripts sont bloqués)

1. Copiez le dossier `extension` vers
   - Windows : `%APPDATA%\Adobe\CEP\extensions\com.local.claudebridge`
   - macOS : `~/Library/Application Support/Adobe/CEP/extensions/com.local.claudebridge`
2. Activez les extensions non signées :
   - Windows : dans `regedit`, sous `HKEY_CURRENT_USER\Software\Adobe\CSXS.11` (et `.12`), créez la valeur chaîne `PlayerDebugMode` = `1`.
   - macOS : `defaults write com.adobe.CSXS.11 PlayerDebugMode 1` (et `.12`).
3. Dans `claude_desktop_config.json` (Claude Desktop > Réglages > Développeur > Modifier la config) :
   ```json
   {
     "mcpServers": {
       "premiere": { "command": "node", "args": ["C:\\chemin\\premiere-claude-bridge\\mcp-server\\index.js"] }
     }
   }
   ```

## Ce que Claude peut faire

| Domaine | Outils |
|---|---|
| Projet | `get_project_info`, `list_project_items`, `import_files`, `create_bin`, `rename_item`, `save_project`, `open_project` |
| Séquences | `list_sequences`, `set_active_sequence`, `create_sequence`, `create_sequence_from_clips`, `get_sequence_info`, `set_in_out` |
| Timeline | `insert_clip` (insertion/recouvrement), `remove_clip` (avec ou sans ripple), `move_clip`, `set_clip_timing`, `set_clip_enabled`, `select_clip`, `get_selection`, `razor`, `set_playhead` |
| Effets | `get_clip_effects`, `set_clip_effect_property` (valeur ou image clé : échelle, position, opacité…), `list_available_effects`, `add_effect`, `add_transition` |
| Marqueurs | `add_marker`, `list_markers` |
| Export | `find_export_presets`, `export_sequence` (direct ou Media Encoder), `export_frame` (PNG renvoyé à Claude pour qu'il **voie** l'image) |
| Sources et fichiers | `get_source_info`, `preview_source`, `list_files`, `read_file` (voir ci-dessous) |
| Analyse | `analyze_rhythm`, `analyze_color`, `analyze_audio` (voir ci-dessous) |
| Annulation | `undo` (une ou plusieurs actions), `redo`, `list_checkpoints`, `create_checkpoint`, `restore_checkpoint` |
| Avancé | `execute_extendscript` : exécute n'importe quel code ExtendScript — couvre tout ce que l'API de Premiere permet |

Les temps sont en secondes ; les pistes et clips sont indexés à partir de 0 (V1 = piste vidéo 0).
Les noms d'effets/composants sont ceux de la langue de votre Premiere (ex. « Trajectoire » / « Motion »).

## Accès aux sources et aux fichiers du projet

- **`get_source_info`** — fiche d'un rush : fichier sur disque (présent ou hors ligne, taille, date), durée, cadence, résolution,
  codec et audio (colonnes de Premiere), métadonnées caméra / XMP (date de tournage, modèle, scène, description…), commentaires
  et marqueurs posés sur le rush, points d'entrée/sortie marqués, et **toutes les séquences où il est utilisé** (piste, position, partie du rush).
- **`preview_source`** — Claude **regarde** un rush sans toucher au montage : planche contact d'images réparties sur le rush
  (ou une plage donnée), mesures d'exposition/couleur, et en option le son (niveau, silences, tempo).
  Une séquence temporaire est créée dans un chutier `_Claude (temporaire)` puis supprimée, et votre séquence active est rétablie.
- **`list_files` / `read_file`** — parcourir et lire les fichiers autour du projet : sous-titres (.srt, .vtt), script, notes,
  CSV, EDL, XML… (texte renvoyé en clair) et images (.png, .jpg… renvoyées pour être vues). Les vidéos et sons se regardent avec `preview_source`.

Par sécurité, l'accès disque est **limité au dossier du projet et aux dossiers qui contiennent ses médias**
(les `..` et liens symboliques sont résolus avant la vérification). Pour ajouter d'autres dossiers :
`PREMIERE_BRIDGE_EXTRA_ROOTS` (séparés par `;` sous Windows, `:` sous macOS). Pour couper l'accès aux fichiers : `PREMIERE_BRIDGE_DISABLE_FILES=1`.

Exemples : *« Quels rushes de la scène 12 n'ai-je pas encore utilisés ? »*, *« Montre-moi le rush C0042 et dis-moi où est la meilleure partie »*,
*« Lis le fichier de sous-titres et place des marqueurs aux changements de sujet »*.

## Analyse du montage

Tout est calculé sur votre machine par le serveur MCP (aucun service en ligne, aucune dépendance).

**Rythme — `analyze_rhythm`**
Reconstitue les plans réellement visibles (piste vidéo la plus haute, raccords invisibles fusionnés) et donne :
nombre de plans, durée moyenne et médiane, coupes par minute, cadence par tranche de 10 s, accélération ou ralentissement,
plans flash (≤ 3 images), plans anormalement longs, trous noirs.
Avec `withMusic` (et `musicTrackIndex` pour la piste musique) : tempo en BPM, % de coupes calées sur les temps,
liste des coupes décalées avec leur écart en millisecondes.

**Image — `analyze_color`**
Exporte une image au milieu de chaque plan (ou réparties / à des instants donnés), avec l'étalonnage appliqué, et mesure :
exposition (luminance moyenne, percentiles), contraste, hautes lumières brûlées, noirs bouchés, saturation,
balance des blancs (dominante chaude/froide et verte/magenta, estimée sur les zones neutres).
Signale les plans qui s'écartent du reste et les raccords où l'image change brusquement, et renvoie à Claude
une **planche contact numérotée** pour qu'il voie les images.

**Son — `analyze_audio`**
Exporte le son en WAV temporaire et mesure : loudness intégrée (LUFS, norme EBU R128 / BS.1770), plage dynamique (LRA),
crête, échantillons saturés, équilibre gauche/droite et corrélation de phase, courbe de niveau, silences, tempo.
Compare à une cible (`web` -14 LUFS, `podcast` -16, `broadcast` -23, `cinema`) et indique le gain à appliquer.
Avec `perTrack` : chaque piste est exportée seule (les autres sont rendues muettes puis remises en l'état)
pour comparer voix / musique / ambiance dans le temps.

L'analyse audio a besoin d'un préréglage d'export WAV (.epr). Il est cherché automatiquement parmi les préréglages de
Premiere ; sinon créez-en un (Waveform Audio 48 kHz 16 bits) et indiquez son chemin à Claude (`presetPath`).

Exemples de demandes : *« Analyse le rythme de mon montage et dis-moi où il traîne »*, *« Les coupes tombent-elles
sur la musique ? »*, *« Vérifie que l'étalonnage est cohérent entre les plans »*, *« Mon mix est-il prêt pour YouTube,
et la musique couvre-t-elle la voix ? »*.

## Annuler les erreurs de Claude

Avant chaque action qui modifie le projet (import, insertion, coupe, effet, marqueur, script…), le plugin
**enregistre le projet** et en garde une copie (« point de restauration ») dans `~/.premiere-claude-bridge/checkpoints/`.

- *« Annule ce que tu viens de faire »* → `undo` : le projet est remis dans l'état d'avant la dernière action, puis rechargé dans Premiere.
- *« Annule les 3 dernières actions »* → `undo` avec `steps: 3`.
- *« Finalement remets-le »* → `redo`.
- *« Reviens à l'état d'avant le montage de l'intro »* → `list_checkpoints` puis `restore_checkpoint` (lui-même annulable).

Bon à savoir :
- votre projet est donc **enregistré automatiquement** avant chaque modification faite par Claude ;
- une annulation recharge le projet (quelques secondes sur un gros projet) : l'historique Ctrl+Z interne de Premiere repart de zéro, mais vos modifications manuelles non enregistrées sont d'abord sauvegardées dans un point de restauration, rien n'est perdu ;
- les 30 derniers points sont conservés par projet (une copie du `.prproj`, sans les médias) ;
- une nouvelle action après un `undo` efface les possibilités de `redo`, comme dans tout logiciel.

## Options

Variables d'environnement du serveur MCP (dans `"env"` de la config Claude) :

- `PREMIERE_BRIDGE_DISABLE_SCRIPT=1` : retire l'outil `execute_extendscript` (si votre organisation ne veut pas d'exécution de code arbitraire).
- `PREMIERE_BRIDGE_TIMEOUT_MS` : délai max d'une commande (défaut 120000).
- `PREMIERE_BRIDGE_CONFIG` : autre emplacement pour `bridge.json` (les points de restauration sont rangés à côté).
- `PREMIERE_BRIDGE_DISABLE_FILES=1` : retire `list_files` et `read_file`.
- `PREMIERE_BRIDGE_EXTRA_ROOTS` : dossiers supplémentaires lisibles par Claude.
- `PREMIERE_BRIDGE_AUTO_CHECKPOINT=0` : désactive les points de restauration automatiques (seuls `create_checkpoint` manuels restent).
- `PREMIERE_BRIDGE_MAX_CHECKPOINTS` : nombre de points conservés par projet (défaut 30).

Pour changer de port, modifiez `"port"` dans `~/.premiere-claude-bridge/bridge.json` puis cliquez sur **Redémarrer** dans le panneau.

## Limites connues

- Le panneau doit être ouvert dans Premiere pour que Claude puisse agir.
- `razor`, `add_effect`, `add_transition`, `list_available_effects`, `export_frame` et `analyze_color` utilisent l'API « QE » de Premiere, non documentée : elles peuvent varier selon les versions.
- Les analyses donnent des mesures objectives (niveaux, durées, dominantes) ; le jugement artistique reste à Claude et à vous. La mesure de crête est une crête échantillon (pas un true peak suréchantillonné).
- L'API de scripting de Premiere ne donne pas accès à son Ctrl+Z : l'annulation passe donc par les points de restauration (rechargement du projet).

## Dépannage

- **Le panneau n'apparaît pas dans Fenêtre > Extensions** : `PlayerDebugMode` n'est pas actif pour votre version CEP (essayez CSXS.12 / CSXS.13), ou le dossier n'est pas au bon endroit. Redémarrez Premiere.
- **« Premiere Pro ne répond pas »** : le panneau est fermé ou le voyant est rouge (port occupé → changez le port).
- **« Jeton invalide »** : le fichier `bridge.json` a été régénéré ; redémarrez le panneau.
- **Débogage** : avec Premiere ouvert, allez sur `http://localhost:8088` dans Chrome pour inspecter le panneau.

## Test (sans Premiere)

```
cd mcp-server && node test.js
```
Simule l'API de Premiere, exécute le vrai `host.jsx` et dialogue en MCP avec le serveur.
