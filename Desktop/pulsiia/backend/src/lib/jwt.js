'use strict';

const jwt = require('jsonwebtoken');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── Chargement des clés RS256 ───────────────────────────────────────────────
// Supporte deux modes :
//   1. Fichiers PEM (dev) → JWT_PRIVATE_KEY_PATH / JWT_PUBLIC_KEY_PATH
//   2. Variables env PEM inline (prod) → JWT_PRIVATE_KEY / JWT_PUBLIC_KEY

function loadKey(envPath, envInline, label) {
  if (envInline) return envInline.replace(/\\n/g, '\n');
  if (envPath) {
    const abs = path.resolve(process.cwd(), envPath);
    if (fs.existsSync(abs)) return fs.readFileSync(abs, 'utf8');
  }
  throw new Error(`JWT ${label} key not found. Run \`npm run keys:generate\` then set env.`);
}

const privateKey = loadKey(
  process.env.JWT_PRIVATE_KEY_PATH,
  process.env.JWT_PRIVATE_KEY,
  'private',
);
const publicKey = loadKey(
  process.env.JWT_PUBLIC_KEY_PATH,
  process.env.JWT_PUBLIC_KEY,
  'public',
);

const ACCESS_TTL = process.env.JWT_ACCESS_TTL || '15m';
const REFRESH_TTL = process.env.JWT_REFRESH_TTL || '7d';
const ISSUER = process.env.JWT_ISSUER || 'pulsiia';
const AUDIENCE = process.env.JWT_AUDIENCE || 'pulsiia-app';

// ─── Génération ──────────────────────────────────────────────────────────────

function signAccess(payload) {
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    expiresIn: ACCESS_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

// jti unique pour chaque refresh — stocké hashé en DB pour révocation
function signRefresh(payload) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ ...payload, jti }, privateKey, {
    algorithm: 'RS256',
    expiresIn: REFRESH_TTL,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  return { token, jti };
}

// ─── Vérification ────────────────────────────────────────────────────────────

function verifyAccess(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

function verifyRefresh(token) {
  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

// Hash du jti pour stockage en DB (on ne stocke jamais le token en clair)
function hashJti(jti) {
  return crypto.createHash('sha256').update(jti).digest('hex');
}

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh, hashJti };
