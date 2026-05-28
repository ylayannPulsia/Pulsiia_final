#!/usr/bin/env node
/**
 * Pulsiia — Export des clés JWT en variables d'environnement inline
 * Usage : node scripts/export-jwt-env.js
 *
 * Sortie : les 4 variables JWT_*_KEY prêtes à coller dans Railway / VPS .env
 * (PEM converti en 1 ligne avec \n au lieu des vrais sauts de ligne)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const KEYS = [
  { file: 'jwt-private.pem',         env: 'JWT_PRIVATE_KEY' },
  { file: 'jwt-public.pem',          env: 'JWT_PUBLIC_KEY' },
  { file: 'jwt-refresh-private.pem', env: 'JWT_REFRESH_PRIVATE_KEY' },
  { file: 'jwt-refresh-public.pem',  env: 'JWT_REFRESH_PUBLIC_KEY' },
];

console.log('\n🔑 Pulsiia — Clés JWT pour la production\n');
console.log('Colle les lignes suivantes dans tes variables d\'environnement :\n');
console.log('─'.repeat(60));

for (const { file, env } of KEYS) {
  const filePath = path.join(__dirname, '..', 'keys', file);

  if (!fs.existsSync(filePath)) {
    console.error(`❌ Fichier manquant : ${filePath}`);
    console.error('   Lance d\'abord : npm run jwt:keys');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8').trimEnd();
  const inline  = content.replace(/\n/g, '\\n');

  console.log(`\n${env}="${inline}"`);
}

console.log('\n' + '─'.repeat(60));
console.log('\n✅ Copie chaque ligne dans tes variables d\'env (Railway, VPS .env, etc.)');
console.log('⚠️  Ne partage JAMAIS les clés PRIVATE avec qui que ce soit !\n');
