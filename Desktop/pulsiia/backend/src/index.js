'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const { authLimiter, apiLimiter } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');

const authRouter = require('./routes/auth');

const app = express();

// ─── Sécurité ───────────────────────────────────────────────────────────────
app.set('trust proxy', 1); // Derrière Nginx
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
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

// Placeholder routes (à implémenter en Phase 2)
const notImplemented = (req, res) =>
  res.status(501).json({ error: 'Module en cours de développement', code: 'NOT_IMPLEMENTED' });

app.use('/api/planning', apiLimiter, notImplemented);
app.use('/api/absences', apiLimiter, notImplemented);
app.use('/api/prepaie', apiLimiter, notImplemented);
app.use('/api/bienetre', apiLimiter, notImplemented);
app.use('/api/dashboard', apiLimiter, notImplemented);
app.use('/api/users', apiLimiter, notImplemented);
app.use('/api/sites', apiLimiter, notImplemented);
app.use('/api/push', apiLimiter, notImplemented);
app.use('/api/rgpd', apiLimiter, notImplemented);
app.use('/api/files', apiLimiter, notImplemented);

// ─── 404 ─────────────────────────────────────────────────────────────────────
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
