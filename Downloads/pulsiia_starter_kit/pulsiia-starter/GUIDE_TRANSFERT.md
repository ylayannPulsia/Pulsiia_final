# 🔄 Transfert de la maquette vers le SaaS

Ce guide t'explique étape par étape comment transformer ta maquette HTML statique en SaaS fonctionnel avec Claude Code dans VSCode.

---

## 📦 Étape 1 — Préparer ton environnement (Windows + WSL2)

### Si tu travailles sous Windows avec WSL2

```bash
# Ouvre WSL2 (Ubuntu)
wsl

# Va dans ton dossier de travail
cd ~

# Si tu n'as pas Node.js, installe-le
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Vérifie
node --version  # devrait afficher v20.x.x
npm --version
```

### Installe Docker Desktop
- Télécharge [Docker Desktop pour Windows](https://www.docker.com/products/docker-desktop)
- Active "Use WSL 2 based engine" dans les paramètres
- Redémarre ton PC

### Installe VSCode + Claude Code
- [VSCode](https://code.visualstudio.com/)
- Dans VSCode, va dans Extensions (Ctrl+Shift+X), cherche "Claude Code", installe
- Installe aussi "WSL" pour pouvoir ouvrir des projets WSL depuis VSCode
- Connecte-toi à ton compte Anthropic dans Claude Code

---

## 📁 Étape 2 — Créer le projet

Dans WSL2 :

```bash
# Crée le dossier de ton projet
cd ~
mkdir pulsiia
cd pulsiia

# Copie le contenu de pulsiia-starter dans ce dossier
# (depuis l'archive ZIP que je te livre)
# Tu peux soit utiliser scp, soit déposer le ZIP dans Windows
# puis le copier depuis /mnt/c/Users/TON_USER/Downloads/ vers ~/pulsiia/

# Ouvre VSCode dans ce dossier
code .
```

VSCode s'ouvrira sur Windows mais connecté à WSL2. Tu verras dans le coin en bas à gauche **"WSL: Ubuntu"**.

---

## 🚀 Étape 3 — Premier lancement

```bash
# 1. Démarre PostgreSQL via Docker
docker-compose up -d postgres

# 2. Configure le backend
cd backend
cp .env.example .env
# (Édite .env si besoin, les valeurs par défaut marchent en dev)

# 3. Installe les dépendances
npm install

# 4. Crée la DB et les données démo
npx prisma generate
npx prisma migrate dev --name init
npm run seed

# 5. Lance le backend
npm run dev
```

Tu devrais voir :
```
🟢 Pulsiia API — http://localhost:3001
```

**Ouvre un nouveau terminal** (Ctrl+Shift+` dans VSCode) :

```bash
cd ~/pulsiia/frontend
npm install
npm run dev
```

```
🟢 Pulsiia Frontend — http://localhost:3000
```

Ouvre [http://localhost:3000](http://localhost:3000) dans ton navigateur. Tu verras la page de démarrage avec un bouton "Tester le login". Clique dessus — si tout va bien tu verras **"✅ Connecté en tant que Marie Lambert (DRH)"**.

---

## 🎨 Étape 4 — Transférer ta maquette

Tu as ton fichier `pulsiia_mvp_v3_desktop.html` (10000+ lignes).

```bash
# Depuis Windows, copie ta maquette dans le projet
cp /mnt/c/Users/TON_USER/Downloads/pulsiia_mvp_v3_desktop.html \
   ~/pulsiia/frontend/public/maquette.html
```

**Ne remplace pas tout de suite `index.html`** — on va d'abord adapter la maquette progressivement.

---

## 🤖 Étape 5 — Connecter la maquette au backend avec Claude Code

Ouvre Claude Code dans VSCode (Ctrl+Shift+P → "Claude Code: Open").

### Prompt 1 — Préparation

```
J'ai dans frontend/public/maquette.html ma maquette Pulsiia HTML (10000+ lignes)
qui utilise des données fictives en JavaScript.

J'ai aussi frontend/public/js/api.js qui contient mon client API.

Étape 1 : Lis maquette.html et fais-moi un résumé des principales pages 
et de la structure JavaScript (état, fonctions, etc.) pour qu'on puisse 
planifier la migration vers le backend.

Ne modifie rien pour l'instant. Donne-moi juste un plan d'action.
```

Claude Code va lire le fichier et te proposer un plan. Valide-le, puis enchaîne :

### Prompt 2 — Migration progressive

```
Bon, on commence par la page Dashboard. Dans maquette.html :

1. Trouve la fonction qui initialise le dashboard avec les données fictives
2. Remplace les données fictives par un appel à api.dashboardKpis()
3. Garde toutes les animations et le style existants
4. Ajoute un état "loading" avec skeleton pendant le chargement
5. Gère les erreurs (offline, 401, 500)
6. Quand c'est prêt, copie ce fichier modifié vers frontend/public/index.html
   en remplaçant celui qui existe

Avant de modifier, montre-moi quelles sections du fichier tu vas changer.
```

### Prompt 3 — Auth flow

```
Crée frontend/public/login.html avec un design qui respecte la DA Pulsiia :
- Fond dégradé F8FAFC → EEF2FF
- Card centrale blanche, border-radius 24px, ombre généreuse
- Logo Pulsiia en haut (carré violet 56x56 avec "P" blanc)
- Titre "Bonjour 👋" + sous-titre "Connectez-vous à Pulsiia"
- Champ email + champ password
- Bouton "Se connecter" violet
- Lien "Mot de passe oublié ?"
- Au submit, appelle api.login() et redirige vers /
- Gère les erreurs avec un message clair

Police : Plus Jakarta Sans (Google Fonts).
```

### Prompt 4 — Protection des routes

```
Dans frontend/public/index.html, ajoute en haut du <script> un check 
d'authentification : si window.Auth.isAuthenticated() est false, 
redirige vers /login.html.

Sinon, charge api.me() au démarrage et stocke l'utilisateur dans une 
variable globale window.currentUser pour qu'on puisse afficher son nom 
et son rôle dans le header.
```

### Prompt 5 — Module Planning

```
Lis le CDC section 7 (Planning). Implémente le module backend :

1. backend/src/routes/planning.js avec ces endpoints :
   - GET /api/planning/week?from=YYYY-MM-DD
   - POST /api/planning/shifts
   - PUT /api/planning/shifts/:id
   - DELETE /api/planning/shifts/:id
   - GET /api/planning/alerts (postes découverts)

2. Ajoute-le dans backend/src/index.js (déjà commenté en TODO)

3. Tests d'intégration dans tests/integration/planning.test.js

4. Dans frontend/public/index.html, connecte la page Planning aux nouveaux 
   endpoints (remplace les données fictives).
```

Continue ainsi avec chaque module : Pré-paie, Absences, Bien-être, Documents, etc.

---

## 💡 Astuces pour bien travailler avec Claude Code

### Garde le CDC ouvert
Quand tu demandes à Claude Code d'implémenter une feature, référence directement le CDC :
```
"Implémente le module Pré-paie selon la section 7 du CDC (page X)."
```

### Une feature = un commit
Après chaque feature qui marche, commit immédiatement :
```bash
git add .
git commit -m "feat(planning): implement week view with API"
```

Si Claude Code casse quelque chose, tu peux toujours revenir en arrière :
```bash
git checkout HEAD~1 -- frontend/public/index.html
```

### Demande des tests
Toujours ajouter "+ tests Jest pour cette feature" à la fin de tes prompts.

### Itère par petits pas
N'essaie pas de faire migrer 5 pages d'un coup. Une page, un test, un commit.

### Utilise Prisma Studio
Pour explorer la DB visuellement :
```bash
cd backend
npx prisma studio
# Ouvre http://localhost:5555
```

---

## 🐛 Problèmes fréquents

### "Cannot connect to database"
Vérifie que Docker tourne : `docker ps`. Si rien, relance : `docker-compose up -d postgres`.

### "Port 3001 already in use"
Un autre processus tourne dessus. Trouve-le :
```bash
lsof -i :3001
kill -9 <PID>
```

### "CORS error" dans le navigateur
Vérifie que `FRONTEND_URL` dans `backend/.env` correspond bien à l'URL du frontend (`http://localhost:3000`).

### "Token expired" en boucle
Les tokens font 15min. Le refresh devrait être automatique via `api.js`. Si ça boucle, supprime les tokens : `localStorage.clear(); sessionStorage.clear();` dans la console.

### Claude Code ne trouve pas un fichier
Donne-lui le chemin complet : `frontend/public/index.html` au lieu de `index.html`.

---

## 📊 Workflow recommandé

1. **Matin** : ouvre le CDC, choisis ce que tu vas faire aujourd'hui
2. **Démarre les services** : `docker-compose up -d postgres` + `npm run dev` (backend + frontend)
3. **Travaille avec Claude Code** : un prompt clair, une feature, un test
4. **Vérifie dans le navigateur** que ça marche
5. **Commit** dès que ça marche
6. **Push** en fin de journée
7. **Soir** : si tu déploies, regarde [DEPLOYMENT.md](DEPLOYMENT.md)

---

## 🔐 Fonctionnalités prod (2026)

### Mot de passe oublié
1. Page login → « Mot de passe oublié » (saisir l'e-mail d'abord)
2. Lien reçu par e-mail → `/reset-password.html?token=...`
3. **Sans SMTP** : le lien s'affiche dans les logs backend (`[auth] reset link (dev):`)

Variables `.env` :
```env
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM=Pulsiia <notifications@votredomaine.com>
FRONTEND_URL=http://localhost:3000
```

### Photo de profil & RGPD
- **Mes paramètres** : prénom, nom, téléphone, photo (clic sur l'avatar)
- **RGPD** : consentements, export JSON, demande de suppression (30 j)
- API : `/api/rgpd/*`, `/api/files/:id`, `/api/users/me/avatar`

### Import CSV collaborateurs
Format (en-tête obligatoire) :
```csv
firstName,lastName,email,jobTitle,site,contractType,role
Jean,Dupont,jean.dupont@exemple.fr,Serveur,Paris 11,CDI,COLLABORATEUR
```
Bouton **↑ Import CSV** sur la page Collaborateurs.

### Planning API
- Module `planning-api.js` — plus de mock `COLLABS`
- Endpoint : `GET /api/planning/week-all?from=YYYY-MM-DD`

### Communication — pièces jointes
- Bouton 📎 dans le canal → fichier joint au prochain message

### Double authentification (2FA)
- **Mon profil** ou **Paramètres → Sécurité & RGPD** → « Double authentification »
- Application compatible : Google Authenticator, Authy, etc. (TOTP)
- À la connexion : après e-mail/mot de passe, saisie du code à 6 chiffres
- API : `POST /api/auth/2fa/setup`, `/enable`, `/disable`, `/verify-login`

### Paramètres RH — onglet Sécurité & RGPD
- Mot de passe, 2FA, déconnexion de toutes les sessions
- Consentements RGPD, export JSON, demande de suppression (identique à Mon profil)

### Avatars collaborateurs
- Les photos de profil uploadées s'affichent sur les cartes de la page **Collaborateurs**

### Documents RH — signature Yousign (eIDAS)
Signatures via **[Yousign](https://yousign.com)** (prestataire français, conforme règlement eIDAS).

1. Créer un compte [sandbox Yousign](https://developers.yousign.com/) et une clé API
2. Dans `backend/.env` :
```env
YOUSIGN_API_KEY=votre_cle_sandbox
YOUSIGN_BASE_URL=https://api-sandbox.yousign.app/v3
YOUSIGN_SIGNATURE_LEVEL=advanced_electronic_signature
YOUSIGN_AUTH_MODE=otp_email
SMTP_HOST=...   # pour e-mails de signature / relance
EMAIL_FROM=Pulsiia <notifications@votredomaine.com>
```
3. Document **PDF** + statut **En attente signature** → procédure Yousign + e-mail au signataire
4. Webhook (prod) : `POST https://votre-api/api/documents/webhooks/yousign`

Fonctions page **Documents RH** : aperçu PDF, modifier/supprimer, versions, export CSV/ZIP, filtre établissement, relance e-mail.

Page **Mes documents** (collab) : liste API, téléchargement, upload perso, suppression.

Commandes : `npx prisma migrate deploy` puis redémarrer le backend.

---

## 🆘 Si tu galères

Pose-moi des questions précises :
- "Comment connecter la page X à l'API ?"
- "L'endpoint Y renvoie une erreur 500, voici le log : ..."
- "Le style ne s'applique pas sur Z, voici le HTML : ..."

Plus c'est précis, plus je peux t'aider.

**Bon courage ! 🚀**
