# Pulsiia — Guide de démarrage

## Lancer l'application

```bash
cd backend
npm run dev
```

Puis ouvrir **http://localhost:3001** dans le navigateur.

---

## Comptes de test

| Rôle | Email | Mot de passe |
|------|-------|--------------|
| DRH | marie.lambert@pulsiia.fr | Pulsiia2026! |
| Collaboratrice | lea.anders@pulsiia.fr | Collab2026! |
| Manager | thomas.martin@pulsiia.fr | Pulsiia2026! |

---

## Structure du projet

```
pulsiia/
├── Maquettes.html          # Application principale (SPA)
├── frontend/
│   ├── login.html          # Page de connexion
│   └── js/
│       ├── api.js          # Client API (fetch + JWT)
│       └── pages.js        # Logique par page (connecte l'UI au backend)
├── backend/
│   ├── src/
│   │   ├── app.js          # Express app
│   │   ├── server.js       # Point d'entrée
│   │   ├── middleware/
│   │   │   ├── auth.js     # JWT middleware
│   │   │   └── security.js # Helmet, CORS, rate-limit
│   │   └── routes/
│   │       ├── auth.js           # Login, logout, profil
│   │       ├── dashboard.js      # KPIs, flux, alertes
│   │       ├── absences.js       # CRUD absences
│   │       ├── planning.js       # CRUD planning/shifts
│   │       ├── prepaie.js        # Variables de prépaie
│   │       ├── collaborateurs.js # Liste employés
│   │       ├── documents.js      # Documents RH
│   │       ├── bienetre.js       # Stats bien-être
│   │       ├── qcm.js            # Campagnes QCM
│   │       ├── communication.js  # Annonces
│   │       └── notifications.js  # Notifications
│   ├── prisma/
│   │   ├── schema.prisma   # Schéma BDD SQLite
│   │   └── seed.js         # Données de démonstration
│   ├── package.json
│   └── .env                # Variables d'environnement (non commité)
├── docs/
│   └── DEMARRAGE.md        # Ce fichier
└── pulsiia_deploy_kit_v1/  # Kit de déploiement Docker
```

---

## Commandes utiles

```bash
# Démarrer (production)
cd backend && npm start

# Développement (rechargement automatique)
cd backend && npm run dev

# Réinitialiser la base de données
cd backend && npx prisma migrate reset && node prisma/seed.js

# Explorer la BDD visuellement
cd backend && npm run db:studio

# Export prépaie CSV
GET http://localhost:3001/api/prepaie/export?format=csv&periode=mars-2026
```

---

## Endpoints API principaux

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| POST | /api/auth/login | Connexion |
| GET | /api/auth/me | Profil utilisateur |
| GET | /api/dashboard/kpis | KPIs temps réel |
| GET | /api/absences | Liste des absences |
| POST | /api/absences | Déclarer une absence |
| PATCH | /api/absences/:id/statut | Valider/refuser |
| GET | /api/planning | Planning de la semaine |
| GET | /api/prepaie | Variables de prépaie |
| POST | /api/prepaie/valider-tout | Tout valider |
| GET | /api/prepaie/export?format=csv | Export CSV |
| GET | /api/collaborateurs | Liste employés (RH) |
| GET | /api/notifications | Notifications |
| POST | /api/notifications/tout-lire | Marquer tout lu |

---

## Sécurité

- **JWT** : access token 2h + refresh token 30j
- **Bcrypt** : hashage des mots de passe (12 rounds)
- **Helmet** : headers HTTP sécurisés
- **Rate limiting** : 20 req/15min sur le login
- **CORS** : restreint au domaine configuré
- **Rôles** : RH > MANAGER > COLLABORATEUR (contrôle par route)
