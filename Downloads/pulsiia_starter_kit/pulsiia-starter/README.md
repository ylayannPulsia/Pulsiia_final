# 🚀 Pulsiia — Démarrage rapide

Bienvenue dans le projet **Pulsiia**, ton SaaS RH "le pouls de ton entreprise, aussi simple qu'un jeu d'enfant".

Ce repo contient :
- **`backend/`** : API Node.js + Express + Prisma + PostgreSQL
- **`frontend/`** : SPA (la maquette `pulsiia_mvp_v3_desktop.html` devient l'app)
- **`docker-compose.yml`** : Stack complète en dev local
- **`.github/workflows/`** : CI/CD GitHub Actions

---

## ⚡ Démarrage en 5 minutes

### Prérequis
- **Node.js 20+** ([nodejs.org](https://nodejs.org))
- **Docker Desktop** ([docker.com](https://www.docker.com/products/docker-desktop))
- **VSCode** avec l'extension **Claude Code** installée
- **Git** (déjà installé sur ton Windows/WSL2)

### Installation

```bash
# 1. Cloner ou copier ce repo dans WSL2
cd ~
git init pulsiia
cd pulsiia
# (copie le contenu de pulsiia-starter ici)

# 2. Configurer l'environnement
cp backend/.env.example backend/.env
# Édite backend/.env si besoin (mots de passe DB, etc.)

# 3. Démarrer PostgreSQL via Docker
docker-compose up -d postgres

# 4. Installer les dépendances backend
cd backend
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed   # Crée les comptes initiaux (Marie Lambert, etc.)

# 5. Lancer le backend
npm run dev   # → http://localhost:3001

# 6. Dans un autre terminal, lancer le frontend
cd ../frontend
npm install
npm run dev   # → http://localhost:3000
```

### Comptes initiaux (seed)

| Rôle | Email | Mot de passe |
|------|-------|--------------|
| DRH | marie.lambert@saveurs-co.fr | Pulsiia2026! |
| Manager | thomas.martin@saveurs-co.fr | Pulsiia2026! |
| RH | camille.rey@saveurs-co.fr | Pulsiia2026! |
| Collab | lea.arnaud@saveurs-co.fr | Pulsiia2026! |

---

## 🎯 Comment travailler avec Claude Code dans VSCode

### Setup Claude Code

1. Ouvre VSCode dans le dossier du projet : `code .`
2. Installe l'extension **Claude Code** depuis le marketplace
3. Connecte-toi avec ton compte Anthropic
4. Ouvre le panneau Claude Code (Ctrl+Shift+P → "Claude Code: Open")

### Prompts efficaces pour démarrer

Ces prompts sont à copier-coller dans Claude Code dans VSCode :

#### 🔧 Étape 1 — Connecter la maquette au backend

```
Lis le fichier frontend/public/index.html qui est la maquette actuelle Pulsiia.
Cette maquette utilise des données fictives en JavaScript. Je veux que tu :

1. Crée frontend/public/js/api.js avec un client API qui appelle 
   http://localhost:3001/api (configurable via window.__PULSIIA_CONFIG__)
2. Implémente la gestion automatique du refresh token JWT
3. Remplace les données fictives du dashboard par de vrais appels API à 
   /api/dashboard/kpis et /api/dashboard/activity
4. Garde toutes les animations et le style existants

N'utilise pas de framework — reste en vanilla JS comme la maquette.
```

#### 🎨 Étape 2 — Appliquer la nouvelle DA "jeu d'enfant"

```
La maquette actuelle a une DA sombre/professionnelle. Je veux la transformer 
selon la nouvelle direction artistique du CDC :

- Palette : violet primaire #5B5BF7, corail #FF8A5B, menthe #4FD1C5, 
  jaune soleil #FBBF24, rose #F472B6
- Sidebar passe d'un fond noir (#0F1117) à un fond nuage clair (#F8FAFC)
- Border-radius généreux partout (12-20px)
- Police : Plus Jakarta Sans
- Ton chaleureux : "Bonjour Marie 👋" au lieu de "Tableau de bord"

Modifie le fichier frontend/public/index.html en gardant la structure mais 
en appliquant cette nouvelle DA. Garde le bouton Pulse en bas à droite mais 
adapte ses couleurs.
```

#### 🗄️ Étape 3 — Schema Prisma complet

```
Crée le fichier backend/prisma/schema.prisma avec les 18 modèles décrits 
dans le CDC section 10.2 : Company, Site, User, Shift, Absence, PayVariable, 
Survey, Question, SurveyResponse, Answer, RefreshToken, PushSubscription, 
ConsentLog, DataExportRequest, DeletionRequest, AuditLog, SSOAccount, UploadedFile.

Règles :
- Toutes les FK avec onDelete cascade ou restrict selon la sémantique
- @@index sur companyId, userId, siteId partout où c'est filtré
- enum PayVariableType, AbsenceType, UserRole
- Multi-tenant : tout est lié à une Company
```

#### 🔐 Étape 4 — Module Auth complet

```
Implémente le module auth complet dans backend/src/routes/auth.js et 
backend/src/middleware/auth.js :

- POST /api/auth/login (email+password, retourne access+refresh tokens)
- POST /api/auth/refresh (refresh token → nouvel access token)
- POST /api/auth/logout (invalide le refresh token en DB)
- GET  /api/auth/me (retourne l'utilisateur courant)
- POST /api/auth/change-password
- POST /api/auth/check-domain (vérifie si SSO configuré pour ce domaine)

Utilise bcrypt 12 pour les mots de passe, JWT RS256 (clés en .env).
Middleware authenticate et authorize(roles) pour RBAC.
Tests Jest associés dans backend/tests/integration/auth.test.js.
```

#### 📅 Étape 5 — Module Planning

```
Implémente le module Planning :

- Modèle Shift dans schema.prisma (date, userId, siteId, type [MATIN/APREM/NUIT/OFF/ABSENT], startTime, endTime)
- GET /api/planning/week?from=2026-05-04 → retourne 7 jours groupés par user
- POST/PUT/DELETE /api/planning/shifts
- GET /api/planning/alerts → postes découverts détectés
- Génération auto de PayVariable au validate du shift (HS si > 35h/semaine)

Tests d'intégration dans tests/integration/planning.test.js.
```

#### 💰 Étape 6 — Module Pré-paie + Export

```
Implémente le module Pré-paie :

- GET /api/prepaie/variables?period=2026-05&site=xxx → liste variables
- GET /api/prepaie/summary → KPIs (à valider, validées, anomalies, total €)
- PUT /api/prepaie/variables/:id/validate
- POST /api/prepaie/validate-all (valide toutes les variables d'un coup)
- GET /api/prepaie/export?format=silae&period=2026-05 → CSV format Silae

Format Silae CSV : matricule;rubrique;valeur;unite;date_debut;date_fin
Format Sage : TXT pipe-séparé
Format ADP : XML
Format générique : CSV simple

Tests dans tests/integration/prepaie.test.js.
```

#### 🎯 Étape 7 — Connecter chaque page

Une fois les modules backend prêts, demande à Claude Code de connecter 
chaque page une par une :

```
Lis frontend/public/index.html. La page "Planning" affiche actuellement 
des données fictives. Modifie la fonction renderPlanning() pour qu'elle 
appelle GET /api/planning/week?from=[lundi de la semaine courante] et 
affiche les vraies données. Gère le loading state (skeleton), les erreurs, 
et le mode offline (cache via Service Worker).
```

Répète pour : Pré-paie, Bien-être, Absences, Communication, Documents, etc.

---

## 📦 Scripts utiles

```bash
# Backend
npm run dev        # Lance le serveur avec nodemon
npm run start      # Production
npm run test       # Tests Jest
npm run seed       # Réinitialise les données initiales
npm run lint       # ESLint

# Frontend
npm run dev        # Serveur local (http://localhost:3000)

# Prisma
npx prisma studio        # GUI pour explorer la DB (http://localhost:5555)
npx prisma migrate dev   # Crée une nouvelle migration
npx prisma generate      # Régénère le client

# Docker
docker-compose up -d        # Lance tous les services
docker-compose down         # Arrête tout
docker-compose logs -f api  # Logs en temps réel
```

---

## 🗂️ Structure du projet

```
pulsiia/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma      # 18 modèles Prisma
│   │   └── seed.js            # Données initiales
│   ├── src/
│   │   ├── index.js           # Express app
│   │   ├── middleware/        # auth, audit, rate-limit
│   │   ├── routes/            # auth, planning, prepaie, ...
│   │   ├── services/          # email, push
│   │   └── jobs/              # scheduler (cron)
│   ├── tests/                 # Jest tests
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── public/
│   │   ├── index.html         # ← Ta maquette pulsiia_mvp_v3
│   │   ├── manifest.json      # PWA
│   │   ├── sw.js              # Service Worker
│   │   ├── js/
│   │   │   ├── api.js         # Client API
│   │   │   ├── app.js         # Router + state
│   │   │   ├── pwa.js         # PWA install + push
│   │   │   └── errors.js      # Error boundaries
│   │   └── icons/             # Icons PWA
│   ├── server.js              # Express servant le SPA
│   └── package.json
├── docker-compose.yml         # Dev local
├── docker-compose.prod.yml    # Production
├── nginx.prod.conf            # Reverse proxy
├── .github/workflows/         # CI/CD
└── README.md
```

---

## 🚢 Déploiement production

Quand l'app est prête en local, déploiement sur VPS Hetzner :

```bash
# 1. Acheter un VPS Hetzner CX22 (~4€/mois) à Falkenstein ou Helsinki
# 2. Pointer pulsiia.com, app.pulsiia.com, api.pulsiia.com vers son IP
# 3. Lancer le script de setup
bash scripts/setup-vps.sh  # Sur le VPS

# 4. Configurer GitHub Secrets : SSH_PRIVATE_KEY, SSH_HOST, SSH_USER
# 5. Push sur main → CI/CD déploie automatiquement
git push origin main
```

---

## 💡 Conseils pour bien travailler avec Claude Code

1. **Une feature à la fois** : ne demande pas tout d'un coup. Une route, un test, une page.
2. **Donne le contexte** : "Lis le fichier X" avant de demander une modif.
3. **Demande des tests** : "Ajoute les tests Jest pour cette route".
4. **Itère** : si Claude se trompe, dis-lui exactement quoi corriger.
5. **Garde le CDC ouvert** : référence-y Claude ("section 7.2 du CDC").
6. **Commit souvent** : après chaque feature qui marche, `git commit`.

---

## 📚 Ressources

- **CDC complet** : `pulsiia_cdc_complet.pdf` (le brief produit)
- **Maquette HTML** : `frontend/public/index.html` (le point de départ)
- **Prisma docs** : https://www.prisma.io/docs
- **Express docs** : https://expressjs.com
- **Eurécia (DA inspiration)** : https://www.eurecia.com/quotidien-rh

Bonne chance ! 🎉
