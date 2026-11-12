#!/bin/bash
# Installe le panneau Claude Bridge pour Premiere Pro (macOS, utilisateur courant, sans sudo).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.local.claudebridge"

echo "Copie de l'extension vers $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$ROOT/extension/." "$DEST/"

# Autorise les extensions non signées (PlayerDebugMode).
for v in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
echo "PlayerDebugMode activé (CSXS 9 à 13)."

if command -v node >/dev/null 2>&1; then
  node "$HERE/configure-claude.js"
else
  echo "Node.js introuvable : installez Node 18+ puis lancez 'node install/configure-claude.js'."
fi
echo
echo "Terminé. Redémarrez Premiere Pro puis ouvrez Fenêtre > Extensions > Claude Bridge, et redémarrez Claude."
