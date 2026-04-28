require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express = require('express');
const morgan = require('morgan');
const path = require('path');
const { helmet, cors, corsOptions, apiLimiter } = require('./middleware/security');

const app = express();

// ── Sécurité ──────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors(corsOptions));
app.use(apiLimiter);
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Frontend statique ─────────────────────────────────────────────────────────
// Sert les fichiers depuis le dossier racine (pulsiia/)
const publicDir = path.join(__dirname, '../../');
app.use(express.static(publicDir, { index: 'login.html' }));

// Redirect /app → Maquettes.html
app.get('/app', (req, res) => res.sendFile(path.join(publicDir, 'Maquettes.html')));
app.get('/app.html', (req, res) => res.sendFile(path.join(publicDir, 'Maquettes.html')));

// ── Routes API ────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/collaborateurs', require('./routes/collaborateurs'));
app.use('/api/absences', require('./routes/absences'));
app.use('/api/planning', require('./routes/planning'));
app.use('/api/prepaie', require('./routes/prepaie'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/bienetre', require('./routes/bienetre'));
app.use('/api/qcm', require('./routes/qcm'));
app.use('/api/communication', require('./routes/communication'));
app.use('/api/notifications', require('./routes/notifications'));

// Sites (simple)
app.get('/api/sites', async (req, res) => {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const sites = await prisma.site.findMany({ orderBy: { nom: 'asc' } });
  res.json(sites);
});

// ── Santé ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date() }));

// ── 404 API ───────────────────────────────────────────────────────────────────
app.use('/api/*', (req, res) => res.status(404).json({ error: 'Endpoint introuvable' }));

// ── Erreur globale ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

module.exports = app;
