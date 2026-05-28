// src/lib/jwt.js — JWT RS256 (clés asymétriques access + refresh)
const fs = require('fs');
const jwt = require('jsonwebtoken');

const ALGORITHM = 'RS256';

function normalizePem(value) {
  if (!value) return null;
  return value.replace(/\\n/g, '\n').trim();
}

function loadPem(inlineEnv, pathEnv, label) {
  const inline = normalizePem(process.env[inlineEnv]);
  if (inline) return inline;

  const filePath = process.env[pathEnv];
  if (filePath) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }

  throw new Error(
    `JWT RS256 : définir ${inlineEnv} ou ${pathEnv} (${label}). ` +
    'Génère les clés avec : npm run jwt:keys',
  );
}

let keys = null;

function getKeys() {
  if (!keys) {
    keys = {
      accessPrivate: loadPem('JWT_PRIVATE_KEY', 'JWT_PRIVATE_KEY_PATH', 'access — signature'),
      accessPublic: loadPem('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_PATH', 'access — vérification'),
      refreshPrivate: loadPem('JWT_REFRESH_PRIVATE_KEY', 'JWT_REFRESH_PRIVATE_KEY_PATH', 'refresh — signature'),
      refreshPublic: loadPem('JWT_REFRESH_PUBLIC_KEY', 'JWT_REFRESH_PUBLIC_KEY_PATH', 'refresh — vérification'),
    };
  }
  return keys;
}

function signAccess(payload, options = {}) {
  const { accessPrivate } = getKeys();
  return jwt.sign(payload, accessPrivate, {
    algorithm: ALGORITHM,
    expiresIn: options.expiresIn || process.env.JWT_EXPIRES_IN || '15m',
  });
}

function signRefresh(payload, options = {}) {
  const { refreshPrivate } = getKeys();
  return jwt.sign(payload, refreshPrivate, {
    algorithm: ALGORITHM,
    expiresIn: options.expiresIn || process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });
}

function verifyAccess(token) {
  const { accessPublic } = getKeys();
  return jwt.verify(token, accessPublic, { algorithms: [ALGORITHM] });
}

function verifyRefresh(token) {
  const { refreshPublic } = getKeys();
  return jwt.verify(token, refreshPublic, { algorithms: [ALGORITHM] });
}

/** Valide la présence des clés au démarrage. */
function assertJwtConfig() {
  getKeys();
}

module.exports = {
  ALGORITHM,
  signAccess,
  signRefresh,
  verifyAccess,
  verifyRefresh,
  assertJwtConfig,
};
