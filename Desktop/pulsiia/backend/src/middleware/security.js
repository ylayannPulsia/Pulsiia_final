const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const corsOptions = {
  origin: (origin, cb) => {
    // Allow same-origin, curl tests, and configured frontend
    if (!origin || origin === process.env.FRONTEND_URL) return cb(null, true);
    cb(new Error('CORS non autorisé'));
  },
  credentials: true,
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Trop de tentatives, réessayez dans 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Trop de requêtes' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { helmet, corsOptions, authLimiter, apiLimiter, cors };
