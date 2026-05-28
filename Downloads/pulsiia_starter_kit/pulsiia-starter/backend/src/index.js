// ═══════════════════════════════════════════════════════════════
// PULSIIA — Backend Express (Phase 1)
// ═══════════════════════════════════════════════════════════════

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const express = require('express');
const { assertJwtConfig } = require('./lib/jwt');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
const { configureTrustProxy, forceHttps, helmetOptions } = require('./middleware/security');

const authRoutes      = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const planningRoutes  = require('./routes/planning');
const planningAiRoutes = require('./routes/planning-ai');
const prepaieRoutes   = require('./routes/prepaie');
const timesheetsRoutes = require('./routes/timesheets');
const bienetreRoutes  = require('./routes/bienetre');
const absenceRoutes   = require('./routes/absences');
const usersRoutes     = require('./routes/users');
const sitesRoutes     = require('./routes/sites');
const documentsRoutes = require('./routes/documents');
const communicationRoutes = require('./routes/communication');
const pushRoutes      = require('./routes/push');
const rgpdRoutes      = require('./routes/rgpd');
const filesRoutes     = require('./routes/files');
const auditRoutes     = require('./routes/audit');
const companyRoutes   = require('./routes/company');
const reportsRoutes   = require('./routes/reports');
const notificationsRoutes = require('./routes/notifications');
const billingRoutes   = require('./routes/billing');
const demoRoutes      = require('./routes/demo');

const app = express();
const PORT = process.env.PORT || 3001;

configureTrustProxy(app);

// ── Middleware ─────────────────────────────────────────────────
app.use(forceHttps);
app.use(helmet(helmetOptions()));
const devOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

// En dev, accepte aussi les IP locales (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
// pour les tests depuis un téléphone sur le même réseau WiFi
function isLocalNetworkOrigin(origin) {
  if (process.env.NODE_ENV !== 'development') return false;
  try {
    const { hostname } = new URL(origin);
    return /^192\.168\.\d+\.\d+$/.test(hostname)
      || /^10\.\d+\.\d+\.\d+$/.test(hostname)
      || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname);
  } catch { return false; }
}

app.use(cors({
  origin(origin, callback) {
    // Requêtes sans Origin (curl, Postman, apps mobiles) — OK
    if (!origin) return callback(null, true);
    if (process.env.NODE_ENV === 'development' && devOrigins.includes(origin)) {
      return callback(null, true);
    }
    if (isLocalNetworkOrigin(origin)) return callback(null, true);
    const allowed = process.env.FRONTEND_URL || 'http://localhost:3000';
    if (origin === allowed) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

// ── Rate limiting ──────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 200 : 30,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Routes ─────────────────────────────────────────────────────
const { mailProvider, verifyMailTransport, mailDiagnostics } = require('./lib/mail');
app.get('/health', async (req, res) => {
  const mail = mailProvider();
  const payload = {
    status: 'ok',
    version: '1.0.0',
    env: process.env.NODE_ENV,
    mail: mail || 'not_configured',
  };
  if (req.query.mail === '1') {
    payload.mailDiagnostics = mailDiagnostics();
    payload.mailVerify = await verifyMailTransport();
  }
  res.json(payload);
});

app.use('/api/auth',      authLimiter, authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/planning/ai', planningAiRoutes);
app.use('/api/planning',  planningRoutes);
app.use('/api/prepaie',   prepaieRoutes);
app.use('/api/prepaie/timesheets', timesheetsRoutes);
app.use('/api/bienetre',  bienetreRoutes);
app.use('/api/absences',  absenceRoutes);
app.use('/api/users',     usersRoutes);
app.use('/api/sites',     sitesRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/communication', communicationRoutes);
app.use('/api/push',      pushRoutes);
app.use('/api/audit',     auditRoutes);
app.use('/api/rgpd',      rgpdRoutes);
app.use('/api/files',     filesRoutes);
app.use('/api/company',   companyRoutes);
app.use('/api/reports',   reportsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/billing',   billingRoutes);
app.use('/api/demo',      demoRoutes);

// TODO: Demande à Claude Code d'implémenter ces modules un par un :

// ── 404 ────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route introuvable : ${req.method} ${req.path}` });
});

// ── Error handler ──────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  const status = err.status || 500;
  const message =
    status === 401 ? 'Non authentifié.' :
    status === 403 ? 'Accès refusé.' :
    status >= 500 && process.env.NODE_ENV === 'production' ? 'Erreur serveur.' :
    err.message || 'Erreur serveur.';
  res.status(status).json({ error: message });
});

// ── Start ──────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  try {
    assertJwtConfig();
  } catch (err) {
    console.error(`\n❌ ${err.message}\n`);
    process.exit(1);
  }

  const emailProvider = mailProvider();
  const server = app.listen(PORT, () => {
    console.log(`\n🟢 Pulsiia API — http://localhost:${PORT}`);
    console.log(`   Env  : ${process.env.NODE_ENV}`);
    console.log(`   CORS : ${process.env.FRONTEND_URL}`);
    console.log(`   Mail : ${emailProvider || 'non configuré (console uniquement)'}\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${PORT} déjà utilisé — une autre instance tourne déjà.`);
      console.error('   Windows : netstat -ano | findstr :' + PORT);
      console.error('           taskkill /F /PID <pid>\n');
      process.exit(1);
    }
    throw err;
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

module.exports = app;
