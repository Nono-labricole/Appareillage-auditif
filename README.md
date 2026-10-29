# Appareillage auditif

Application Android qui rend **n'importe quel appareil auditif Bluetooth** (Phonak, Signia,
Oticon, Widex, ReSound, Starkey, Unitron… ou de simples écouteurs) compatible avec deux
fonctions :

1. **Sous-titres en direct** – le téléphone transcrit en texte ce qui se dit autour de vous.
2. **Micro déporté** – posez le téléphone au milieu de la table (réunion, repas de famille) :
   il capte les voix, les nettoie, les amplifie et les envoie dans vos appareils. Les micros
   de vos appareils restent actifs, vous entendez donc les deux.

L'objectif : **ne pas avoir à acheter de micro déporté du fabricant** (Roger, PartnerMic,
ConnectClip…). Le smartphone, qu'on a toujours sur soi, fait ce travail, quelle que soit la
marque du téléphone ou des appareils.

Fonctionne sur Android 8.0 et plus récent, toutes marques de téléphone (conçu en pensant au
Nothing Phone (3a)).

## Pourquoi le « mode appareil auditif » d'Android ne marche pas avec un Phonak ?

Android n'active ses fonctions d'appareil auditif que pour les appareils qui utilisent l'un
de ces deux protocoles Bluetooth :

- **ASHA** (Audio Streaming for Hearing Aids), créé par Google ;
- **Bluetooth LE Audio** (profil HAP).

La plupart des Phonak (Marvel, Paradise, Lumity…) se connectent en **Bluetooth classique**,
comme un casque. Android les voit donc comme de simples écouteurs, même si vous changez le
« type d'appareil » dans les paramètres : ce réglage ne change que l'icône et les statistiques
d'exposition au bruit, pas le protocole utilisé. Aucune application ne peut modifier ce
comportement sans accès root ni mise à jour du micrologiciel des appareils.

Cette application contourne le problème : elle n'a pas besoin que le système reconnaisse
l'appareil, elle utilise simplement la sortie audio Bluetooth qui, elle, fonctionne déjà.

## Installation

1. Sur le téléphone, ouvrez la page **Releases** du dépôt GitHub et téléchargez
   `AppareillageAuditif.apk` (dernière version).
2. Ouvrez le fichier ; Android demande d'autoriser l'installation depuis le navigateur ou
   le gestionnaire de fichiers : acceptez.
3. Lancez **Appareillage auditif** et accordez l'accès au micro et aux notifications.

## Utilisation

### Micro déporté

1. Connectez vos appareils auditifs en Bluetooth (comme d'habitude).
2. Posez le téléphone **à plat, écran vers le haut, au centre de la table**.
3. Activez **Micro déporté**.
4. Réglez le **Volume** et la **Clarté de la voix** (renforce les aigus qui rendent la
   parole intelligible et atténue les basses qui « bourdonnent »).
5. La **réduction du bruit de fond** baisse automatiquement le son entre les phrases
   (bruits de couverts, ventilation…).

**Liaison Bluetooth** :

- *Qualité* (par défaut) : son riche, mais le Bluetooth classique ajoute un décalage
  (≈ 150 à 250 ms selon les appareils). Comme les micros des appareils restent actifs, vous
  pouvez entendre un léger écho pour les voix proches.
- *Faible latence* : utilise le profil « appel téléphonique » du Bluetooth. Le décalage est
  bien plus court (moins d'écho), le son est un peu moins riche (16 kHz, suffisant pour la
  voix). Certains appareils baissent leurs propres micros pendant un « appel ».

Essayez les deux et gardez celui qui vous convient le mieux.

**Sécurité anti-larsen** : si les appareils se déconnectent, la sortie est immédiatement
coupée pour que le son ne parte jamais dans le haut-parleur du téléphone.

### Sous-titres en direct

- Activez **Sous-titres en direct** : le texte s'affiche au fur et à mesure (en gris pendant
  que la phrase est en cours).
- **Plein écran** : texte en grand, écran toujours allumé, taille réglable.
- **Partager** : envoie la transcription (mail, messages, notes…).
- **Micro utilisé** :
  - *Micro du téléphone* : le mieux en réunion (téléphone au centre) ;
  - *Micros de l'appareil auditif* : transcrit ce que captent vos appareils (Android 13+,
    nécessite que l'appareil accepte les appels Bluetooth).
- Avec le micro déporté actif, les sous-titres utilisent le même micro que lui.
- **Hors connexion** : la transcription se fait sur le téléphone (plus privé, marche sans
  réseau). Si la langue n'est pas téléchargée, l'application passe en ligne et propose le
  téléchargement.

La reconnaissance vocale utilise le moteur installé sur le téléphone (en général celui de
Google). Si rien ne s'affiche, installez/mettez à jour l'application **Google** ou
**Services de reconnaissance vocale de Google** depuis le Play Store.

## Conseils

- La batterie : le micro déporté consomme environ autant qu'un appel. Branchez le téléphone
  pour un long repas.
- Le mode « Filtre anti-bruit du téléphone » (type de micro) utilise le traitement de
  l'opérateur/constructeur prévu pour les appels : utile dans un lieu très bruyant, moins
  naturel ailleurs.

## Technique

- Kotlin, sans dépendance réseau, aucune donnée envoyée par l'application elle-même
  (la reconnaissance en ligne, si utilisée, passe par le moteur du téléphone).
- `audio/AudioEngine.kt` : capture (AudioRecord), routage Bluetooth (A2DP, SCO, ASHA,
  LE Audio, Auracast), sortie basse latence (AudioTrack), coupure anti-larsen.
- `audio/Dsp.kt` : passe-haut, égaliseur de clarté, expanseur (réduction de bruit),
  compresseur, limiteur ; ré-échantillonnage 48 → 16 kHz pour la transcription.
- `captions/TranscriptionEngine.kt` : reconnaissance continue avec `SpeechRecognizer`.
  Sur Android 13+, l'audio est fourni par l'application (`EXTRA_AUDIO_SOURCE`), ce qui
  permet de partager le micro avec le micro déporté.
- `HearingService.kt` : service de premier plan (fonctionne écran éteint).

Compilation : `./gradlew assembleRelease` (JDK 17, SDK Android 35). L'APK est aussi compilé
automatiquement par GitHub Actions à chaque envoi.
