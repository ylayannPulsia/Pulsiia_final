'use strict';

require('dotenv').config();

const path    = require('path');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const morgan  = require('morgan');

const { authLimiter, apiLimiter } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');

const authRouter = require('./routes/auth');
const planningRouter = require('./routes/planning');
const absencesRouter = require('./routes/absences');
const prepaieRouter = require('./routes/prepaie');
const bienetreRouter = require('./routes/bienetre');
const communicationRouter = require('./routes/communication');
const dashboardRouter = require('./routes/dashboard');
const usersRouter = require('./routes/users');
const sitesRouter = require('./routes/sites');

const app = express();

// ─── Sécurité ───────────────────────────────────────────────────────────────
const FRONTEND = path.resolve(__dirname, '../../frontend');

app.set('trust proxy', 1); // Derrière Nginx
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Autoriser les requêtes sans origin (curl, Postman, tests)
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origine non autorisée — ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Body parsing ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ─── Logging ─────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ─── Health check (avant rate-limit) ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/auth', authLimiter, authRouter);
app.use('/api/planning', apiLimiter, planningRouter);
app.use('/api/absences', apiLimiter, absencesRouter);
app.use('/api/prepaie', apiLimiter, prepaieRouter);
app.use('/api/bienetre', apiLimiter, bienetreRouter);
app.use('/api/communication', apiLimiter, communicationRouter);
app.use('/api/dashboard', apiLimiter, dashboardRouter);
app.use('/api/users', apiLimiter, usersRouter);
app.use('/api/sites', apiLimiter, sitesRouter);

// ─── Frontend statique ───────────────────────────────────────────────────────
app.use(express.static(FRONTEND));
// SPA fallback : tout ce qui n'est pas /api → index.html
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND, 'index.html'));
});

// ─── 404 API ─────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable', code: 'NOT_FOUND' });
});

// ─── Gestionnaire d'erreurs global ───────────────────────────────────────────
app.use(errorHandler);

// ─── Démarrage ───────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = Number(process.env.PORT || 3001);
  app.listen(PORT, () => {
    console.log(`🚀 Pulsiia API démarrée sur http://localhost:${PORT}`);
    console.log(`   Environnement : ${process.env.NODE_ENV || 'development'}`);
  });
}

module.exports = app;
