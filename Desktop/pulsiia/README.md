# Pulsiia

> Le pouls de votre entreprise, aussi simple qu'un jeu d'enfant.

Plateforme SaaS RH française : **planning + pré-paie + bien-être** pour les PME.  
Stack : Node.js 20 · Express · Prisma · PostgreSQL 15 · JWT RS256 · Docker

---

## Démarrage rapide

### Prérequis
- Node.js 20+
- Docker & Docker Compose

### 1. Cloner et installer

```bash
git clone <repo-url>
cd pulsiia/backend
npm install
```

### 2. Variables d'environnement

```bash
cp .env.example .env
# Éditer .env avec vos valeurs
```

### 3. Générer les clés JWT

```bash
npm run keys:generate
# Crée backend/keys/jwt-private.pem + jwt-public.pem (jamais committés)
```

### 4. Démarrer Postgres

```bash
# Depuis la racine du repo :
docker compose up -d
# Postgres disponible sur localhost:5432
```

### 5. Migrations + seed

```bash
cd backend
npm run db:migrate     # Applique les migrations Prisma
npm run db:seed        # Crée les données de démo Saveurs & Co
```

### 6. Démarrer le backend

```bash
npm run dev
# API disponible sur http://localhost:3001
# Health check : http://localhost:3001/health
```

---

## Comptes de démo

| Rôle | Email | Mot de passe |
|---|---|---|
| DRH | marie.lambert@saveurs-co.fr | Pulsiia2026! |
| Manager | thomas.martin@saveurs-co.fr | Pulsiia2026! |
| RH | camille.rey@saveurs-co.fr | Pulsiia2026! |
| Collaborateur | lea.arnaud@saveurs-co.fr | Pulsiia2026! |

---

## Scripts disponibles

```bash
npm run dev               # Démarrage en mode développement (nodemon)
npm run start             # Production
npm run test              # Tests Jest (runInBand)
npm run test:coverage     # Tests + rapport de couverture
npm run db:generate       # Régénère le client Prisma
npm run db:migrate        # Migration dev
npm run db:migrate:deploy # Migration prod (sans prompt)
npm run db:seed           # Seed Saveurs & Co
npm run db:studio         # Prisma Studio (GUI DB)
npm run db:reset          # Reset complet de la DB (dev uniquement)
npm run keys:generate     # Génère les clés JWT RS256
```

---

## Structure du projet

```
pulsiia/
├── _design-ref/          # Maquettes visuelles (référence DA, ne pas modifier)
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma  # 18 modèles (Company → UploadedFile)
│   │   └── seed.js        # Données démo Saveurs & Co
│   ├── src/
│   │   ├── index.js       # Bootstrap Express
│   │   ├── lib/           # prisma.js, jwt.js
│   │   ├── middleware/    # auth.js, audit.js, rateLimiter.js, errorHandler.js
│   │   ├── routes/        # auth.js (Phase 1) + stubs Phase 2
│   │   └── utils/         # errors.js
│   ├── scripts/
│   │   └── generate-jwt-keys.js
│   ├── tests/
│   │   ├── unit/          # Middleware auth (9 tests)
│   │   └── integration/   # Routes auth (7 tests)
│   ├── Dockerfile
│   ├── .env.example
│   └── package.json
├── docker-compose.yml     # Postgres dev
├── .github/workflows/
│   └── ci.yml             # CI : lint + tests + coverage
└── README.md
```

---

## API — Phase 1 (auth)

| Méthode | Route | Description |
|---|---|---|
| POST | `/api/auth/check-domain` | Mode d'auth selon domaine email |
| POST | `/api/auth/login` | Connexion + tokens JWT |
| POST | `/api/auth/refresh` | Rotation refresh token |
| POST | `/api/auth/logout` | Révocation refresh token |
| GET | `/api/auth/me` | Profil de l'utilisateur connecté |
| POST | `/api/auth/change-password` | Changement de mot de passe |
| POST | `/api/auth/forgot-password` | Demande de réinitialisation |
| POST | `/api/auth/reset-password` | Réinitialisation avec token |

---

## Phases de développement

| Phase | Semaines | Contenu |
|---|---|---|
| **1** ✅ | S1-S2 | Setup, Auth, RBAC, CI/CD |
| 2 | S3-S5 | Planning, Pré-paie, Absences, Bien-être, Communication |
| 3 | S6-S7 | UX/UI DA, Dashboard, PWA, Push, Mobile |
| 4 | S8 | RGPD complet (Art.17/20), Audit logs |
| 5 | S9-S10 | Landing Astro, Tests E2E, Déploiement VPS |

---

## Sécurité

- JWT **RS256** (clés asymétriques) — access 15 min, refresh 7 jours
- Bcrypt **saltRounds=12** en production
- Rate limiting : 10 req/15 min sur auth, 200 req/min sur API
- Helmet.js : CSP, HSTS, X-Frame-Options, nosniff
- Refresh token stocké **hashé** en DB pour révocation
- Rotation du refresh token à chaque `/refresh`
- Clés JWT jamais committées

## Licence

Propriétaire — Pulsiia SAS © 2026. Tous droits réservés.
