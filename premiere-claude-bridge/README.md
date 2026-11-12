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
| Avancé | `execute_extendscript` : exécute n'importe quel code ExtendScript — couvre tout ce que l'API de Premiere permet |

Les temps sont en secondes ; les pistes et clips sont indexés à partir de 0 (V1 = piste vidéo 0).
Les noms d'effets/composants sont ceux de la langue de votre Premiere (ex. « Trajectoire » / « Motion »).

## Options

Variables d'environnement du serveur MCP (dans `"env"` de la config Claude) :

- `PREMIERE_BRIDGE_DISABLE_SCRIPT=1` : retire l'outil `execute_extendscript` (si votre organisation ne veut pas d'exécution de code arbitraire).
- `PREMIERE_BRIDGE_TIMEOUT_MS` : délai max d'une commande (défaut 120000).
- `PREMIERE_BRIDGE_CONFIG` : autre emplacement pour `bridge.json`.

Pour changer de port, modifiez `"port"` dans `~/.premiere-claude-bridge/bridge.json` puis cliquez sur **Redémarrer** dans le panneau.

## Limites connues

- Le panneau doit être ouvert dans Premiere pour que Claude puisse agir.
- `razor`, `add_effect`, `add_transition`, `list_available_effects` et `export_frame` utilisent l'API « QE » de Premiere, non documentée : elles peuvent varier selon les versions.
- L'API de scripting n'offre pas d'annulation programmée : utilisez Ctrl/Cmd+Z dans Premiere si besoin, et enregistrez avant les grosses opérations.

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
