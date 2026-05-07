#!/usr/bin/env node
// Génère une paire de clés RS256 pour JWT.
// Usage : node scripts/generate-jwt-keys.js
// Output : backend/keys/jwt-private.pem + jwt-public.pem

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const keysDir = path.join(__dirname, '..', 'keys');
fs.mkdirSync(keysDir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

fs.writeFileSync(path.join(keysDir, 'jwt-private.pem'), privateKey, { mode: 0o600 });
fs.writeFileSync(path.join(keysDir, 'jwt-public.pem'), publicKey, { mode: 0o644 });

console.log('✓ Clés JWT RS256 générées dans backend/keys/');
console.log('  jwt-private.pem  (ne jamais committer)');
console.log('  jwt-public.pem');
