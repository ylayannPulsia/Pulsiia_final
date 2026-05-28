#!/usr/bin/env node
/**
 * Test SMTP Mailjet depuis le serveur (local ou VPS).
 * Usage : cd backend && node scripts/test-smtp.js votre@email.com
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { verifyMailTransport, mailDiagnostics, sendMail } = require('../src/lib/mail');

async function main() {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: node scripts/test-smtp.js destinataire@exemple.com');
    process.exit(1);
  }

  console.log('Diagnostics:', mailDiagnostics());
  const verify = await verifyMailTransport();
  console.log('Vérification SMTP:', verify);

  if (!verify.ok) {
    process.exit(1);
  }

  const result = await sendMail({
    to,
    subject: 'Test Pulsiia SMTP',
    text: `Test envoyé le ${new Date().toISOString()}`,
    html: `<p>Test Pulsiia SMTP — ${new Date().toISOString()}</p>`,
  });

  console.log('Résultat envoi:', result);
  process.exit(result.sent ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
