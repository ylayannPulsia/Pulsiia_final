# 🚀 Phase 3 — Infrastructure & Déploiement Pulsiia

> Tout est prêt dans le projet. Suis les 8 étapes dans l'ordre.

---

## ⬜ Étape 1 — Choisir la plateforme

Deux chemins possibles. **Commence par Railway** (le plus rapide) :

| Option | Coût | Temps | Recommandé pour |
|--------|------|-------|-----------------|
| **Railway** ← choisir ici | ~5-10€/mois | 20 min | MVP, démo client |
| **VPS Hetzner/Scaleway** | ~5€/mois | 1h (scripts déjà prêts) | Production |

### 🚂 Railway (chemin A — recommandé)

1. Crée un compte sur [railway.app](https://railway.app) avec ton GitHub
2. → **"New Project"** → **"Deploy from GitHub repo"** → sélectionne ton repo Pulsiia
3. Tu verras l'assistant de déploiement — **continue à l'étape 2**

### 🖥️ VPS Hetzner (chemin B)

1. Crée un compte [hetzner.com](https://www.hetzner.com/cloud)
2. → **"Add Server"** → Ubuntu 22.04 → CX22 (2vCPU / 4GB RAM = 4.51€/mois) → **Paris**
3. Récupère l'IP du serveur (ex: `5.75.xxx.xxx`)
4. Continue à l'**Étape 3 chemin B**

---

## ⬜ Étape 2 — Base de données PostgreSQL managée

### 🚂 Railway — PostgreSQL intégré (chemin A)

Dans ton projet Railway :
1. → **"+ New"** → **"Database"** → **"Add PostgreSQL"**
2. Railway crée automatiquement la DB et la variable `DATABASE_URL`
3. Clique sur la base de données → onglet **"Variables"** → copie `DATABASE_URL`

### 🌐 Supabase (alternative gratuite)

1. → [supabase.com](https://supabase.com) → **"New Project"**
2. Choisis la région **"West EU (Paris)"** → note ton mot de passe
3. → **Settings** → **Database** → copie `Connection string (URI)`
4. Format : `postgresql://postgres:TON_PASS@db.XXXX.supabase.co:5432/postgres`

### 🖥️ VPS — PostgreSQL via Docker (chemin B)

PostgreSQL tourne déjà via `docker-compose.yml` sur le VPS.
La `DATABASE_URL` sera : `postgresql://pulsiia:MOT_DE_PASSE@localhost:5432/pulsiia`

---

## ⬜ Étape 3 — Déployer le backend

### 🚂 Railway (chemin A)

Dans Railway, le **backend** se déploie automatiquement depuis GitHub.

**Configure le service backend :**
1. Dans ton projet Railway → service **"backend"**
2. → **Settings** → **"Root Directory"** : `backend`
3. → **"Start Command"** : `node src/index.js`
4. → **Variables** (voir Étape 5 pour les valeurs complètes) — ajoute au minimum :
   ```
   NODE_ENV=production
   PORT=3001
   DATABASE_URL=(copié depuis Railway PostgreSQL)
   ```
5. Le déploiement démarre automatiquement à chaque `git push main`

**Préparer les clés JWT pour Railway :**
```powershell
# Dans backend/ — convertit les clés PEM en 1 ligne pour la variable d'env
node -e "const fs=require('fs'); console.log(fs.readFileSync('./keys/jwt-private.pem','utf8').replace(/\n/g,'\\n'))"
node -e "const fs=require('fs'); console.log(fs.readFileSync('./keys/jwt-public.pem','utf8').replace(/\n/g,'\\n'))"
node -e "const fs=require('fs'); console.log(fs.readFileSync('./keys/jwt-refresh-private.pem','utf8').replace(/\n/g,'\\n'))"
node -e "const fs=require('fs'); console.log(fs.readFileSync('./keys/jwt-refresh-public.pem','utf8').replace(/\n/g,'\\n'))"
```
Colle chaque sortie dans les variables Railway correspondantes.

### 🖥️ VPS (chemin B)

```bash
# 1. Sur ton PC local — envoie ta clé SSH au VPS
ssh-copy-id -p 2222 pulsiia@5.75.XXX.XXX

# 2. Lance le script de setup du VPS (une seule fois)
ssh -p 2222 root@5.75.XXX.XXX 'bash -s' < scripts/setup-vps.sh

# 3. Clone le repo sur le VPS
ssh -p 2222 pulsiia@5.75.XXX.XXX
cd /home/pulsiia
git clone https://github.com/TON_COMPTE/pulsiia.git app
cd app

# 4. Configure le .env de production
cp backend/.env.production.example backend/.env
nano backend/.env  # Remplis DATABASE_URL, JWT_*, etc.

# 5. Lance la DB et le backend
docker compose up -d postgres
cd backend && npm ci --omit=dev
npm run migrate:prod  # = npx prisma migrate deploy
npm run seed          # Données démo
cd ..

# 6. Démarrage avec PM2
npm install -g pm2
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup  # Active le redémarrage automatique au boot
```

---

## ⬜ Étape 4 — Déployer le frontend

Le frontend est un **serveur Node.js Express** (pas juste des fichiers statiques).
Il proxy automatiquement les `/api/*` vers le backend.

### 🚂 Railway (chemin A)

1. Dans Railway → **"+ New Service"** → **"GitHub Repo"** (même repo)
2. → **Settings** → **"Root Directory"** : `frontend`
3. → **"Start Command"** : `node server.js`
4. → **Variables** :
   ```
   NODE_ENV=production
   PORT=3000
   BACKEND_URL=https://URL_DE_TON_BACKEND_RAILWAY.up.railway.app
   ```
5. Railway génère une URL publique (ex: `pulsiia-frontend.up.railway.app`)

> **Tip** : dans Railway, les deux services (backend + frontend) sont dans le même projet.
> Le frontend proxifie vers le backend — les utilisateurs n'accèdent qu'au port du frontend.

### 🖥️ VPS (chemin B — Nginx comme reverse proxy)

```bash
# Lance le script Nginx + SSL (déjà préparé dans le projet)
ssh -p 2222 pulsiia@5.75.XXX.XXX
cd /home/pulsiia/app
bash scripts/setup-nginx.sh
```

Le script configure Nginx pour :
- `app.pulsiia.fr` → frontend (port 3000)
- `api.pulsiia.fr` → backend (port 3001)
- SSL automatique via Let's Encrypt

---

## ⬜ Étape 5 — Variables d'env en production

### Checklist complète des variables à configurer

Copie `.env.production.example` et remplis **chaque valeur** :

```bash
# Variables OBLIGATOIRES (sans elles, l'app ne démarre pas) :
DATABASE_URL=postgresql://...
NODE_ENV=production
JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
JWT_REFRESH_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
JWT_REFRESH_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
FRONTEND_URL=https://app.pulsiia.fr
API_URL=https://api.pulsiia.fr

# Variables RECOMMANDÉES (pour les emails — sinon pas d'invitation collaborateur) :
# Mailjet (copier depuis votre .env local qui fonctionne) :
SMTP_HOST=in-v3.mailjet.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM="Pulsiia <contact@pulsiia.com>"
# Puis : pm2 reload ecosystem.config.js --env production
# Vérifier : curl https://api.pulsiia.fr/health  →  "mail":"smtp"

# Variables OPTIONNELLES (peuvent être ajoutées plus tard) :
ANTHROPIC_API_KEY=sk-ant-...   # Pour le Planning IA
VAPID_PUBLIC_KEY=...            # Pour les notifications push
YOUSIGN_API_KEY=...             # Pour la signature de documents
```

### Convertir les clés JWT (commande locale)

```powershell
# Dans backend/ — génère le contenu des variables JWT_*_KEY
node -e "
const fs = require('fs');
['jwt-private','jwt-public','jwt-refresh-private','jwt-refresh-public'].forEach(k => {
  const content = fs.readFileSync('./keys/'+k+'.pem','utf8').replace(/\n/g,'\\\\n');
  console.log(k.toUpperCase().replace(/-/g,'_') + '=' + JSON.stringify(content));
});"
```

---

## ⬜ Étape 6 — Nom de domaine

### Acheter le domaine

1. → [OVH](https://www.ovh.com/fr/domaines/) ou [Gandi](https://www.gandi.net/fr)
2. Cherche `pulsiia.fr` (ou `.com`, `.io`, etc.)
3. Achète → tu reçois les accès au panneau DNS

### Configurer le DNS

#### Pour VPS (chemin B) — ajoute ces enregistrements DNS :
```
Type  Nom          Valeur
A     app          5.75.XXX.XXX    (IP de ton VPS)
A     api          5.75.XXX.XXX    (même IP)
A     @            5.75.XXX.XXX    (racine, optionnel)
```

#### Pour Railway (chemin A) — "Custom Domain" :
1. Dans Railway → service frontend → **Settings** → **Custom Domain**
2. Tape `app.pulsiia.fr` → Railway te donne un enregistrement CNAME
3. Ajoute le CNAME dans ton panneau DNS OVH/Gandi
4. Répète pour le backend : `api.pulsiia.fr`

> ⏳ La propagation DNS prend 5-30 minutes (parfois 24h max)

---

## ⬜ Étape 7 — Certificat SSL (HTTPS)

### 🚂 Railway (chemin A)

**Automatique !** Railway génère et renouvelle le certificat SSL dès qu'un custom domain est ajouté. Rien à faire.

### 🖥️ VPS — Let's Encrypt (chemin B)

Le script `setup-nginx.sh` installe Certbot. Ensuite :
```bash
# Sur le VPS — génère les certificats SSL
sudo certbot --nginx -d app.pulsiia.fr -d api.pulsiia.fr
# Suit les instructions (email, acceptation CGU)
# Certbot configure Nginx automatiquement

# Vérifier le renouvellement automatique
sudo certbot renew --dry-run
```

---

## ⬜ Étape 8 — Migration de prod (prisma migrate deploy)

> ⚠️ Utilise toujours `migrate deploy` (pas `migrate dev`) en production !

### 🚂 Railway (chemin A)

Railway exécute automatiquement les migrations grâce à ce script dans `package.json` :
```json
"postinstall": "prisma generate"
```

Pour exécuter manuellement la première migration :
1. Dans Railway → service backend → onglet **"Shell"** (si disponible)
2. Ou ajoute temporairement un script de démarrage :
   ```
   npx prisma migrate deploy && node src/index.js
   ```
3. Après la première migration, repasse à : `node src/index.js`

> **Alternative** : ajoute `DATABASE_URL` dans ton `.env` local et lance depuis ton PC :
> ```bash
> cd backend
> DATABASE_URL="postgresql://..." npx prisma migrate deploy
> ```

### 🖥️ VPS (chemin B)

```bash
# Sur le VPS
cd /home/pulsiia/app/backend
NODE_ENV=production npx prisma migrate deploy

# Puis lance le seed (données démo) — SEULEMENT la 1ère fois
node prisma/seed.js
```

### GitHub Actions (automatique pour les 2 chemins)

Le fichier `.github/workflows/deploy.yml` exécute **automatiquement** `prisma migrate deploy`
à chaque `git push main`. Tu n'as rien à faire après la configuration initiale.

---

## ✅ Checklist finale

```
⬜  1. Plateforme choisie : Railway / VPS
⬜  2. PostgreSQL créé et DATABASE_URL récupérée
⬜  3. Backend déployé et accessible (GET /health → { "status": "ok" })
⬜  4. Frontend déployé et accessible (login visible)
⬜  5. Variables d'env complètes (JWT, emails, etc.)
⬜  6. Domaine configuré et DNS propagé
⬜  7. HTTPS actif (cadenas vert dans le navigateur)
⬜  8. Migration Prisma executée + données seed
```

### Test final
```bash
# Backend OK ?
curl https://api.pulsiia.fr/health
# → { "status": "ok", "env": "production" }

# Login OK ?
# → Va sur https://app.pulsiia.fr
# → Marie Lambert / Pulsiia2026!
```

---

## 🔧 GitHub Actions — Configuration (VPS uniquement)

Dans ton repo GitHub → **Settings** → **Secrets and variables** → **Actions** :

```
SSH_HOST         → IP de ton VPS (ex: 5.75.xxx.xxx)
SSH_USER         → pulsiia
SSH_PRIVATE_KEY  → contenu de ta clé privée SSH (~/.ssh/id_rsa)
```

Ensuite, chaque `git push main` déclenche le déploiement automatique. 🎉

---

## 💡 Ordre recommandé si tu pars de zéro

```
1. Crée un compte Railway
2. Connecte ton GitHub
3. Crée le projet Railway depuis le repo
4. Ajoute Railway PostgreSQL → copie DATABASE_URL
5. Génère les variables JWT (commande fournie Étape 5)
6. Configure toutes les variables dans Railway
7. Laisse Railway déployer (automatique)
8. Ajoute le domaine custom (Étape 6)
9. Lance la migration depuis ton PC local (Étape 8)
10. Test final → ✅ Pulsiia en prod !
```
