# Jamf School Reseller Survey

Application **Electron pour macOS** qui audite automatiquement les instances **Jamf School** d'un ou plusieurs revendeurs, puis génère un **rapport PDF compact** orienté action.

Pour chaque école, l'app navigue dans une fenêtre authentifiée (session SSO) et relève :

- l'expiration du certificat **APNs**
- l'expiration du token **VPP**
- l'état du token **DEP / ADE** (dont les **CGU Apple** à accepter)
- les **notifications ouvertes** du dashboard
- les instances **verrouillées** et les **surutilisations de licence**

---

## Fonctionnalités

- **Multi-revendeurs en onglets** — chaque revendeur a sa propre URL de connexion SSO et sa liste d'écoles.
- **Collecte sélective** — par école, on active/désactive APNs · VPP · ADE · Notifications.
- **Rapport PDF par revendeur** — résumé exécutif + sections triées par criticité (🔴 Critique, 🟠 Urgent, ⚠️ CGU, 🔵 Licence, ❌ Inaccessible, ✅ OK, ⏸️ Désactivée) + récapitulatif complet.
- **Livraison configurable** — téléchargement local (Bureau) **ou** publication du PDF sur **Slack** (via bot token).
- **Raison de désactivation** — une école désactivée peut porter un motif, repris dans le rapport.
- **Collecte parallèle** — plusieurs fenêtres partagent la session SSO pour accélérer l'audit.
- **Édition** des revendeurs et des écoles (nom, URL).
- **Mode clair / sombre**.

---

## Prérequis

- **macOS** (Apple Silicon pour le build fourni)
- **Node.js 18–20** et **npm**

---

## Installation & lancement (développement)

```bash
npm install
npm start
```

---

## Construire l'application `.app`

```bash
npm run build
```

Le bundle est généré dans `dist/mac-arm64/Jamf School Reseller Survey.app`.

> L'app n'est pas notarisée Apple : au premier lancement, faire **clic droit → Ouvrir** pour passer Gatekeeper (une seule fois).

---

## Utilisation

1. Ajouter un **revendeur** (« + Revendeur ») avec son **URL de connexion SSO**.
2. Ajouter ses **écoles** (« + École ») — il suffit de l'URL jusqu'à `…jamfcloud.com`, les chemins sont déduits.
3. Cocher les données à collecter par école.
4. (Option) Choisir la livraison **Local** ou **Slack** en bas de fenêtre.
5. Cliquer **▶ Lancer la collecte** sur l'onglet du revendeur.
6. Se connecter dans la fenêtre Jamf qui s'ouvre — la collecte démarre, puis le **PDF** est généré.

### Livraison Slack

Un webhook Slack ne peut pas envoyer de fichier : l'upload du PDF nécessite un **bot token** (`xoxb-…`) avec les scopes **`files:write`** et **`chat:write`**, et le bot doit être invité dans le **canal** cible (renseigner son ID).

---

## Configuration

La configuration est un JSON (`data/instances.json` en dev, copié dans le dossier *userData* en version packagée) :

```jsonc
{
  "delivery": { "mode": "local", "botToken": "", "channelId": "" },
  "masters": [
    {
      "id": "mon-revendeur",
      "name": "Mon Revendeur",
      "loginUrl": "https://xxx.auth-1.jamfcloud.com/?redirect-url=xxx.jamfcloud.com",
      "enabled": true,
      "instances": [
        {
          "id": "mon-ecole",
          "prefix": "Mon École",
          "url": "https://monecole.jamfcloud.com",
          "enabled": true,
          "collectApns": true, "collectVpp": true, "collectDep": true, "collectNotifications": true
        }
      ]
    }
  ]
}
```

Le dépôt est livré **sans aucune donnée** (`masters: []`).

---

## Structure du projet

| Fichier | Rôle |
|---|---|
| `main.js` | Processus principal Electron : fenêtres, IPC, orchestration de la collecte, livraison |
| `preload.js` | Pont sécurisé `window.api` entre le rendu et le processus principal |
| `scraper.js` | Navigation dans les pages Jamf et extraction des données (collecte parallèle) |
| `report.js` | Génération du rapport PDF (HTML → `printToPDF`) |
| `slack.js` | Upload du PDF sur Slack (API `files.getUploadURLExternal`) |
| `renderer/index.html` | Interface de configuration (onglets, écoles, livraison) |
| `renderer/monitor.html` | Fenêtre de progression de la collecte |
| `scripts/sample-report.js` | Génère un PDF d'exemple avec des données fictives |

---

## Aperçu d'un rapport d'exemple

```bash
node_modules/.bin/electron scripts/sample-report.js
```

Génère `Rapport_Revendeur_Démo_AAAA-MM-JJ.pdf` sur le Bureau avec des données 100 % fictives.

---

## Licence

ISC
