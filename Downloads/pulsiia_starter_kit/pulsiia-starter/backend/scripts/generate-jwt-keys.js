#!/usr/bin/env node
// Génère deux paires RSA 2048 (access + refresh) dans backend/keys/
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEYS_DIR = path.join(__dirname, '..', 'keys');

const PAIRS = [
  { private: 'jwt-private.pem', public: 'jwt-public.pem', label: 'access' },
  { private: 'jwt-refresh-private.pem', public: 'jwt-refresh-public.pem', label: 'refresh' },
];

function generateKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

fs.mkdirSync(KEYS_DIR, { recursive: true });

for (const pair of PAIRS) {
  const { publicKey, privateKey } = generateKeyPair();
  fs.writeFileSync(path.join(KEYS_DIR, pair.private), privateKey, { mode: 0o600 });
  fs.writeFileSync(path.join(KEYS_DIR, pair.public), publicKey, { mode: 0o644 });
  console.log(`✓ ${pair.label}: ${pair.private}, ${pair.public}`);
}

console.log(`
Clés écrites dans backend/keys/ (gitignored).

Ajoute dans .env :

JWT_PRIVATE_KEY_PATH=./keys/jwt-private.pem
JWT_PUBLIC_KEY_PATH=./keys/jwt-public.pem
JWT_REFRESH_PRIVATE_KEY_PATH=./keys/jwt-refresh-private.pem
JWT_REFRESH_PUBLIC_KEY_PATH=./keys/jwt-refresh-public.pem
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
`);
