#!/usr/bin/env node
/**
 * Diagnostic Mailjet sur le VPS (sans afficher les secrets en clair).
 * Usage : cd /home/pulsiia/app/backend && node scripts/check-mailjet-env.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { mailDiagnostics, verifyMailTransport, getMailjetCredentials } = require('../src/lib/mail');

async function main() {
  const { apiKey, apiSecret } = getMailjetCredentials();
  console.log('Fichier .env :', path.join(__dirname, '..', '.env'));
  console.log('Diagnostics :', mailDiagnostics());

  if (!apiKey || !apiSecret) {
    console.error('\n❌ Clés manquantes. Ajoutez dans .env :');
    console.error('   MAILJET_API_KEY=...    (API Key Mailjet)');
    console.error('   MAILJET_API_SECRET=... (Secret Key Mailjet)');
    console.error('   ou SMTP_USER / SMTP_PASS avec les mêmes valeurs.');
    process.exit(1);
  }

  if (apiKey.includes('@') || apiSecret.includes('@')) {
    console.warn('\n⚠️  Une clé contient "@" — utilisez API Key / Secret Key Mailjet, pas votre e-mail.');
  }

  if (apiKey.length < 20 || apiSecret.length < 20) {
    console.warn('\n⚠️  Longueur inhabituelle — vérifiez qu’il n’y a pas d’espace ou de guillemets en trop.');
  }

  const verify = await verifyMailTransport();
  console.log('\nVérification Mailjet :', verify);

  if (!verify.ok) {
    console.error('\n❌ Mailjet refuse la connexion (souvent 401 = mauvaises clés).');
    console.error('   1. https://app.mailjet.com/account/apikeys → régénérer une paire');
    console.error('   2. Coller dans .env SANS guillemets :');
    console.error('      MAILJET_API_KEY=xxxxxxxx');
    console.error('      MAILJET_API_SECRET=xxxxxxxx');
    console.error('   3. pm2 reload ecosystem.config.js --env production --update-env');
    process.exit(1);
  }

  console.log('\n✅ Mailjet OK — testez : node scripts/test-smtp.js votre@email.com');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
