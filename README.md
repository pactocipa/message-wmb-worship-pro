# Message WMB Worship Pro (Desktop)

Application de bureau (Electron) séparée de "BIBLE_SONG PRO OBS" — **le projet
original n'est jamais modifié**. Ce dossier contient une copie en lecture seule de
ses fichiers (`app-src/`, recopiée une fois depuis
`C:\Users\admin\Videos\BIBLE_SONG PRO OBS`) et ajoute une gestion native de la
fenêtre de projection par-dessus, sans onglet navigateur à ouvrir/positionner à la main.

## Ce qui est fait

- Fenêtre de contrôle (le panneau habituel) + fenêtre de projection natives.
- Détection des écrans disponibles, plein écran automatique sur l'écran choisi
  (le bouton "Go Live" / sélection d'écran existant dans le panneau pilote
  directement la fenêtre de projection via le pont `window.BSPDesktop` exposé par
  `preload.js` : `getDisplays`, `openOutput`, `closeOutput`, `isOutputOpen`,
  `requestOutputFullscreen`, `onOutputClosed`).
- La synchronisation panneau ↔ affichage existante (BroadcastChannel) continue de
  fonctionner sans aucune modification, car les deux fenêtres chargent les mêmes
  fichiers dans la même session Electron.
- **Installateur Windows (.exe) généré** : `dist\Message WMB Worship Pro Setup 2.1.0.exe`.
- **Sermons et chansons préchargés** : `app-src/bundled-data/sermons.json` (1457 sermons)
  et `app-src/bundled-data/songs.json` (1340 chants) sont importés automatiquement au
  tout premier lancement (voir `seedBundledDataIfEmpty()` dans
  `js/panel/bootstrap-and-init.js`) — rien à importer manuellement après installation.
  Ce préchargement ne se déclenche que si aucun sermon/chanson n'existe déjà ; il
  n'écrase jamais des données déjà importées, modifiées ou supprimées par la suite.
  Un écran de chargement s'affiche pendant l'opération (le parsing du fichier de
  sermons de ~135 Mo bloque un instant l'interface, sans cet écran ça pouvait
  donner l'impression que l'application était plantée).
- **Menu natif "Fichier"** : contient "Importer des fichiers…" (sélecteur de
  fichiers .json, réutilise le même import que le glisser-déposer) et "Ouvrir le
  dossier des fichiers fournis" (ouvre `Documents/Message WMB Worship Pro/Fichiers a
  importer/` dans l'Explorateur — contient une copie de sermons.json/songs.json,
  utile pour réimporter après une suppression sans avoir à réinstaller).
- **Couleur d'arrière-plan du titre/référence réglable** : un champ existait déjà
  dans le code (`refBgColor`) mais n'avait pas de contrôle dans l'interface —
  ajouté dans Réglages → section Bible/Songs, à côté de la couleur du texte de
  référence.

## Pas encore fait (comme convenu, en phases suivantes)

- **NDI** : envoyer le flux de la fenêtre de projection vers OBS via NDI. Nécessite
  le SDK NDI officiel (NewTek/Vizrt) et des outils de compilation natifs (Visual
  Studio Build Tools) pour un module Node natif (ex. `grandiose`).
- Icône personnalisée (utilise l'icône par défaut d'Electron pour l'instant).
- Signature de code (l'installateur n'est pas signé — Windows/SmartScreen peuvent
  afficher un avertissement à l'installation, normal pour un exécutable non signé
  d'un éditeur non enregistré).
- Les autres méthodes `window.BSPDesktop.*` déjà appelées par le code existant
  (plugins audio, enregistrement, streaming, mixage NDI) ne sont pas encore
  implémentées ici — le code existant les détecte et se rabat proprement sur son
  comportement navigateur habituel en leur absence, donc rien n'est cassé.

## Développement (sans passer par l'installateur)

```
npm install
npm start
```

## Mettre à jour la copie de l'application

Si vous modifiez l'application originale (`C:\Users\admin\Videos\BIBLE_SONG PRO OBS`),
il faut recopier les fichiers dans `app-src/` pour que ce projet en tienne compte :

```powershell
robocopy "C:\Users\admin\Videos\BIBLE_SONG PRO OBS" "C:\Users\admin\Videos\BSP Desktop\app-src" /E
```

## Régénérer l'installateur (.exe)

```
npm run dist
```

**Note sur cet environnement** : le téléchargement automatique du runtime Electron
par `electron-builder` s'est montré peu fiable ici (zip tronqué/corrompu à
répétition, y compris en retéléchargeant). Si `npm run dist` échoue avec une erreur
"zip: not a valid zip file", le contournement qui a fonctionné :

1. Télécharger le zip d'Electron manuellement avec `curl.exe` (plus fiable
   qu'`Invoke-WebRequest` dans cet environnement) vers le dossier de cache Electron
   (`%LOCALAPPDATA%\electron\Cache\...`).
2. Assembler `dist\win-unpacked\` à la main à partir de
   `node_modules\electron\dist\` (qui, lui, se télécharge correctement via
   `npm install`) + copier `main.js`, `preload.js`, `app-src\` et un petit
   `package.json` dans `dist\win-unpacked\resources\app\`.
3. Lancer `npx electron-builder --win --prepackaged "dist\win-unpacked" --config.win.target=nsis`
   pour ne générer que l'installateur NSIS à partir du dossier déjà assemblé (les
   binaires NSIS sont petits et se téléchargent sans problème).

## Mettre à jour les données préchargées (sermons/chansons)

```powershell
Copy-Item "C:\Users\admin\Music\Sermons\Sermons Branham (BSS FR - Complet).json" "C:\Users\admin\Videos\BSP Desktop\app-src\bundled-data\sermons.json"
Copy-Item "C:\Users\admin\Music\Sermons\Chants Branham (FR+SW).json" "C:\Users\admin\Videos\BSP Desktop\app-src\bundled-data\songs.json"
```
puis recopier vers `dist\win-unpacked\resources\app\app-src\bundled-data\` avant de relancer `npm run dist` (ou repartir de zéro avec `npm run dist` seul, qui repackage tout `app-src\`).

## Livrable actuel

`dist\Message WMB Worship Pro Setup 2.1.0.exe` — installateur Windows (NSIS), non
signé, ~112 Mo (inclut les sermons et chansons préchargés, menu Fichier natif,
couleur d'arrière-plan du titre réglable).
