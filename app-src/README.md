# Message WMB Worship Pro — Multimédia Jésus Le Roc Tabernacle de Kananga (JRT)

Logiciel de projection biblique et de louange, personnalisé pour l'équipe multimédia de l'église Jésus Le Roc Tabernacle de Kananga.

---

## Fonctionnalités principales

- Recherche et projection de versets bibliques (par livre/chapitre ou mot-clé)
- Bibliothèque de chants avec paroles synchronisées et playlists (Setlist)
- Bandeaux d'annonce animés (Overlays) pour présenter un prédicateur ou une série de prédication
- Fonds d'écran personnalisables : couleur, dégradé, image ou vidéo en boucle
- Mode Plein écran et mode Bandeau (Lowerthird) pour la régie vidéo
- Thèmes, presets et styles personnalisés par élément affiché
- Intégration OBS Studio (Browser Source) et vMix

---

## Structure du projet

- `Bible Song Pro panel.html` — panneau de contrôle (interface régisseur)
- `BSP_display.html` — écran de projection / sortie OBS
- `js/panel/` — logique du panneau de contrôle
- `css/` — styles du panneau et de l'écran de projection

Synchronisation en temps réel entre le panneau et l'écran de projection via `BroadcastChannel` (et, dans la version bureau, un relais IPC fiable en complément).

---

## Utilisation (application bureau)

1. Lancer `Message WMB Worship Pro.exe`
2. Sélectionner un chant, un verset ou un élément de la playlist dans le panneau
3. Ajuster l'apparence dans Paramètres si besoin (police, couleurs, fond, position)
4. Cliquer sur Live pour projeter sur l'écran de sortie

## Utilisation (dock OBS)

1. Ouvrir OBS Studio
2. Ajouter `BSP_display.html` comme Browser Source dans la scène
3. Ajouter `Bible Song Pro panel.html` comme dock de navigateur personnalisé
4. Ouvrir le panneau et piloter l'affichage en direct

---

## Licence

GPL-3.0 — voir [LICENSE](LICENSE) pour le texte complet.
