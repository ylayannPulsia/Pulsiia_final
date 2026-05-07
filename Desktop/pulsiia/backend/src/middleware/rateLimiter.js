'use strict';

const rateLimit = require('express-rate-limit');

function makeJson429(req, res) {
  res.status(429).json({
    error: 'Trop de tentatives, réessayez dans quelques minutes',
    code: 'RATE_LIMIT',
  });
}

// CDC §9.5 — Auth : 10 / 15 min / IP
const authLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_AUTH_WINDOW_MS || 900_000),
  max: Number(process.env.RATE_LIMIT_AUTH_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeJson429,
});

// CDC §9.5 — API standard : 200 / min / utilisateur authentifié
const apiLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_API_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_API_MAX || 200),
  keyGenerator: (req) => req.user?.id || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeJson429,
});

// CDC §9.5 — Public (landing forms) : 10 / min / IP
const publicLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeJson429,
});

module.exports = { authLimiter, apiLimiter, publicLimiter };
