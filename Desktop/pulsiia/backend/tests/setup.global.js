'use strict';

// Chargé UNE FOIS avant toute la suite de tests.
// Met en place les variables d'env de test et génère des clés JWT temporaires.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ||
    'postgresql://pulsiia:pulsiia_dev@localhost:5432/pulsiia_test?schema=public';
  process.env.BCRYPT_SALT_ROUNDS = '4'; // rapide en test
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.JWT_REFRESH_TTL = '7d';
  process.env.JWT_ISSUER = 'pulsiia';
  process.env.JWT_AUDIENCE = 'pulsiia-app';
  process.env.RESET_TOKEN_TTL_MINUTES = '30';
  process.env.PORT = '3099';
  process.env.FRONTEND_URL = 'http://localhost:3000';

  // Génération de clés temporaires pour les tests (en mémoire → fichiers temp)
  const keysDir = path.join(__dirname, '..', 'keys-test');
  fs.mkdirSync(keysDir, { recursive: true });

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const privPath = path.join(keysDir, 'jwt-private.pem');
  const pubPath = path.join(keysDir, 'jwt-public.pem');
  fs.writeFileSync(privPath, privateKey);
  fs.writeFileSync(pubPath, publicKey);

  process.env.JWT_PRIVATE_KEY_PATH = privPath;
  process.env.JWT_PUBLIC_KEY_PATH = pubPath;

  // Expose pour teardown
  global.__TEST_KEYS_DIR__ = keysDir;
};
