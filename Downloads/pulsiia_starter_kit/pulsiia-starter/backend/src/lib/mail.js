// lib/mail.js — Envoi d'e-mails (Resend / SendGrid / SMTP / mode dev)
const nodemailer = require('nodemailer');

let transporter = null;

function smtpConfigured() {
  return Boolean(String(process.env.SMTP_HOST || '').trim());
}

/** Clés Mailjet : API Key + Secret Key (pas l'e-mail du compte). */
function getMailjetCredentials() {
  const apiKey = String(process.env.MAILJET_API_KEY || process.env.SMTP_USER || '').trim();
  const apiSecret = String(process.env.MAILJET_API_SECRET || process.env.SMTP_PASS || '').trim();
  return { apiKey, apiSecret };
}

function isMailjetConfigured() {
  const host = String(process.env.SMTP_HOST || '').toLowerCase();
  const { apiKey, apiSecret } = getMailjetCredentials();
  return (host.includes('mailjet') || apiKey) && Boolean(apiKey && apiSecret);
}

function mailjetAuthHeader() {
  const { apiKey, apiSecret } = getMailjetCredentials();
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`;
}

/** Pour /health?mail=1 — compare avec le dashboard Mailjet sans exposer les secrets. */
function mailCredentialsHint() {
  const { apiKey, apiSecret } = getMailjetCredentials();
  return {
    apiKeyPrefix: apiKey ? `${apiKey.slice(0, 6)}…` : null,
    apiKeyLength: apiKey.length,
    secretLength: apiSecret.length,
    source: process.env.MAILJET_API_KEY ? 'MAILJET_API_KEY' : 'SMTP_USER',
  };
}

function parseEmailFrom() {
  const from = emailFrom();
  const email = from.match(/<([^>]+)>/)?.[1] || from;
  const name = from.match(/^([^<]+)/)?.[1]?.trim() || 'Pulsiia';
  return { email, name };
}

function resetTransporter() {
  transporter = null;
}

function getTransporter() {
  if (transporter) return transporter;

  const host = String(process.env.SMTP_HOST || '').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();

  if (!host) return null;

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 20_000,
  });

  return transporter;
}

function emailFrom() {
  return process.env.EMAIL_FROM || 'Pulsiia <noreply@pulsiia.com>';
}

/** URL de connexion (page login) */
function buildLoginUrl(baseUrl) {
  const base = (baseUrl || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  if (base.endsWith('/login.html')) return base;
  return `${base}/login.html`;
}

function emailLogoHeader(appUrl) {
  const base = (appUrl || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `<p style="margin:0 0 20px"><img src="${base}/assets/logo.svg" width="48" height="48" alt="Pulsiia" style="display:block"></p>`;
}

function mailProvider() {
  if (String(process.env.RESEND_API_KEY || '').trim()) return 'resend';
  if (String(process.env.SENDGRID_API_KEY || '').trim()) return 'sendgrid';
  // Mailjet : API HTTPS (443) — le SMTP (587) est souvent bloqué sur les VPS
  if (isMailjetConfigured()) return 'mailjet';
  if (smtpConfigured()) return 'smtp';
  return null;
}

async function sendViaResend({ to, subject, text, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: emailFrom(),
      to: [to],
      subject,
      text,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return { sent: true, provider: 'resend', messageId: data.id };
}

async function sendViaSendGrid({ to, subject, text, html }) {
  const from = emailFrom();
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from.match(/<([^>]+)>/)?.[1] || from, name: from.match(/^([^<]+)/)?.[1]?.trim() || 'Pulsiia' },
      subject,
      content: [
        { type: 'text/plain', value: text || '' },
        { type: 'text/html', value: html || text || '' },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendGrid ${res.status}: ${body.slice(0, 200)}`);
  }

  const messageId = res.headers.get('x-message-id');
  return { sent: true, provider: 'sendgrid', messageId };
}

async function sendViaMailjetApi({ to, subject, text, html }) {
  const { email: fromEmail, name: fromName } = parseEmailFrom();
  const res = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      Authorization: mailjetAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      Messages: [{
        From: { Email: fromEmail, Name: fromName },
        To: [{ Email: to }],
        Subject: subject,
        TextPart: text || '',
        HTMLPart: html || text || '',
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error(
        'Mailjet refuse la connexion (401) — vérifiez SMTP_USER (API Key) et SMTP_PASS (Secret Key) dans backend/.env sur le serveur.',
      );
    }
    throw new Error(`Mailjet API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const messageId = data.Messages?.[0]?.To?.[0]?.MessageUUID
    || data.Messages?.[0]?.To?.[0]?.MessageID;
  return { sent: true, provider: 'mailjet', messageId };
}

async function sendViaSmtp({ to, subject, text, html }) {
  const tx = getTransporter();
  if (!tx) return null;

  const info = await tx.sendMail({ from: emailFrom(), to, subject, text, html });
  return { sent: true, provider: 'smtp', messageId: info.messageId };
}

async function sendMail({ to, subject, text, html }) {
  const provider = mailProvider();

  if (!provider) {
    console.log('[mail:dev]', { to, subject, text: text?.slice(0, 200) });
    return { sent: false, dev: true, message: 'Aucun fournisseur e-mail configuré — e-mail loggé en console.' };
  }

  try {
    if (provider === 'resend') return await sendViaResend({ to, subject, text, html });
    if (provider === 'sendgrid') return await sendViaSendGrid({ to, subject, text, html });
    if (provider === 'mailjet') return await sendViaMailjetApi({ to, subject, text, html });
    resetTransporter();
    const result = await sendViaSmtp({ to, subject, text, html });
    if (result) return result;
    console.warn('[mail:smtp] échec — vérifiez SMTP_HOST/USER/PASS dans backend/.env');
    console.log('[mail:dev]', { to, subject, text: text?.slice(0, 200) });
    return {
      sent: false,
      dev: true,
      message: 'E-mail non envoyé — redémarrez le backend après modification du fichier .env',
    };
  } catch (err) {
    console.error(`[mail:${provider}]`, err.message);
    throw err;
  }
}

async function sendUserInviteEmail({ to, firstName, lastName, loginUrl, defaultPassword, companyName }) {
  const name = firstName || 'Collaborateur';
  const appUrl = buildLoginUrl(loginUrl);
  const subject = `Votre accès Pulsiia${companyName ? ` — ${companyName}` : ''}`;
  const text = [
    `Bonjour ${name},`,
    '',
    'Un compte Pulsiia a été créé pour vous.',
    '',
    `Connexion : ${appUrl}`,
    `E-mail : ${to}`,
    `Mot de passe temporaire : ${defaultPassword}`,
    '',
    'Nous vous recommandons de changer votre mot de passe dès la première connexion.',
    '',
    '— L\'équipe Pulsiia',
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;color:#111">
      ${emailLogoHeader(appUrl)}
      <p>Bonjour <strong>${name}</strong>,</p>
      <p>Un compte Pulsiia a été créé pour vous${companyName ? ` chez <strong>${companyName}</strong>` : ''}.</p>
      <p style="background:#f3f4f6;padding:14px;border-radius:8px;font-size:14px;line-height:1.6">
        <strong>Connexion :</strong> <a href="${appUrl}">${appUrl}</a><br>
        <strong>E-mail :</strong> ${to}<br>
        <strong>Mot de passe temporaire :</strong> ${defaultPassword}
      </p>
      <p style="font-size:13px;color:#6b7280">Changez votre mot de passe dès la première connexion.</p>
      <p style="font-size:13px;color:#9ca3af">— L'équipe Pulsiia</p>
    </div>`;

  return sendMail({ to, subject, text, html });
}

async function sendPasswordResetEmail({ to, firstName, resetUrl }) {
  const name = firstName || 'Utilisateur';
  const subject = 'Réinitialisation de votre mot de passe Pulsiia';
  const text = [
    `Bonjour ${name},`,
    '',
    'Vous avez demandé la réinitialisation de votre mot de passe.',
    '',
    `Cliquez sur ce lien (valable 1 heure) : ${resetUrl}`,
    '',
    'Si vous n\'êtes pas à l\'origine de cette demande, ignorez cet e-mail.',
    '',
    '— L\'équipe Pulsiia',
  ].join('\n');

  const appUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;color:#111">
      ${emailLogoHeader(appUrl)}
      <p>Bonjour <strong>${name}</strong>,</p>
      <p>Vous avez demandé la réinitialisation de votre mot de passe Pulsiia.</p>
      <p><a href="${resetUrl}" style="display:inline-block;background:#5B5BF7;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Réinitialiser mon mot de passe</a></p>
      <p style="font-size:13px;color:#6b7280">Ce lien expire dans 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail.</p>
    </div>`;

  return sendMail({ to, subject, text, html });
}

async function sendDocumentSignatureEmail({ to, firstName, documentName, signatureLink, providerName, levelLabel }) {
  const name = firstName || 'Collaborateur';
  const provider = providerName || 'Yousign';
  const level = levelLabel || 'signature électronique avancée (eIDAS)';
  const subject = `Signature requise — ${documentName}`;
  const linkBlock = signatureLink
    ? `Signez le document ici (lien sécurisé ${provider}) :\n${signatureLink}\n`
    : 'Votre responsable RH vous enverra le lien de signature via Yousign une fois la procédure activée.\n';

  const text = [
    `Bonjour ${name},`,
    '',
    `Un document RH nécessite votre ${level} :`,
    `« ${documentName} »`,
    '',
    linkBlock,
    `Prestataire : ${provider} — solution française conforme au règlement eIDAS.`,
    '',
    '— L\'équipe Pulsiia',
  ].join('\n');

  const appUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const html = signatureLink
    ? `
    <div style="font-family:system-ui,sans-serif;max-width:520px;color:#111">
      ${emailLogoHeader(appUrl)}
      <p>Bonjour <strong>${name}</strong>,</p>
      <p>Le document <strong>« ${documentName} »</strong> est en attente de votre signature (${level}).</p>
      <p><a href="${signatureLink}" style="display:inline-block;background:#5B5BF7;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Signer via ${provider}</a></p>
      <p style="font-size:12px;color:#6b7280">Prestataire agréé eIDAS · ${provider}</p>
    </div>`
    : `
    <div style="font-family:system-ui,sans-serif;max-width:520px;color:#111">
      ${emailLogoHeader(appUrl)}
      <p>Bonjour <strong>${name}</strong>,</p>
      <p>Le document <strong>« ${documentName} »</strong> sera prochainement disponible pour signature via ${provider} (eIDAS).</p>
    </div>`;

  return sendMail({ to, subject, text, html });
}

async function sendDocumentReminderEmail({ to, firstName, documentName, signatureLink }) {
  const name = firstName || 'Collaborateur';
  const subject = `Rappel — signature en attente : ${documentName}`;
  const text = [
    `Bonjour ${name},`,
    '',
    'Nous vous rappelons que le document suivant est toujours en attente de votre signature :',
    `« ${documentName} »`,
    '',
    signatureLink ? `Lien : ${signatureLink}` : '',
    '',
    '— L\'équipe RH / Pulsiia',
  ].join('\n');

  const appUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;color:#111">
      ${emailLogoHeader(appUrl)}
      <p>Bonjour <strong>${name}</strong>,</p>
      <p>Rappel : le document <strong>« ${documentName} »</strong> attend toujours votre signature.</p>
      ${signatureLink ? `<p><a href="${signatureLink}" style="display:inline-block;background:#F59E0B;color:white;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Signer maintenant</a></p>` : ''}
    </div>`;

  return sendMail({ to, subject, text, html });
}

async function sendCompanyInviteEmail({ to, firstName, companyName, acceptUrl, inviterName }) {
  const name = firstName || 'Collaborateur';
  const subject = `Invitation Pulsiia${companyName ? ` — ${companyName}` : ''}`;
  const inviterLine = inviterName ? `\nInvitation envoyée par ${inviterName}.` : '';
  const text = [
    `Bonjour ${name},`,
    '',
    `Vous êtes invité(e) à rejoindre${companyName ? ` ${companyName}` : ' une nouvelle entreprise'} sur Pulsiia.`,
    'Vous pouvez utiliser le même e-mail et le même mot de passe que pour votre compte existant.',
    '',
    `Accepter l'invitation : ${acceptUrl}`,
    inviterLine,
    '',
    'Ce lien est valable 14 jours.',
    '',
    '— L\'équipe Pulsiia',
  ].join('\n');

  const appUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const html = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;color:#111">
      ${emailLogoHeader(appUrl)}
      <p>Bonjour <strong>${name}</strong>,</p>
      <p>Vous êtes invité(e) à rejoindre${companyName ? ` <strong>${companyName}</strong>` : ' une nouvelle entreprise'} sur Pulsiia.</p>
      <p style="font-size:14px;color:#4b5563">Utilisez le même e-mail et le même mot de passe que pour votre compte Pulsiia actuel.</p>
      <p style="margin:24px 0">
        <a href="${acceptUrl}" style="display:inline-block;background:#5B5BF7;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Accepter l'invitation</a>
      </p>
      <p style="font-size:13px;color:#6b7280">Lien valable 14 jours.${inviterName ? ` Invitation de ${inviterName}.` : ''}</p>
      <p style="font-size:12px;color:#9ca3af;word-break:break-all">${acceptUrl}</p>
    </div>`;

  return sendMail({ to, subject, text, html });
}

function mailDiagnostics() {
  const from = emailFrom();
  const fromEmail = from.match(/<([^>]+)>/)?.[1] || from;
  const provider = mailProvider() || 'none';
  return {
    provider,
    from: fromEmail,
    frontendUrl: process.env.FRONTEND_URL || null,
    smtpHost: process.env.SMTP_HOST ? String(process.env.SMTP_HOST).trim() : null,
    hasSmtpAuth: Boolean(getMailjetCredentials().apiKey && getMailjetCredentials().apiSecret),
    mailjetApi: provider === 'mailjet',
    credentials: mailCredentialsHint(),
  };
}

/** Teste la connexion SMTP (Mailjet, etc.) — ne envoie pas d'e-mail. */
async function verifyMailTransport() {
  const provider = mailProvider();
  if (!provider) {
    return { ok: false, provider: null, error: 'Aucun fournisseur e-mail configuré (SMTP_HOST, RESEND_API_KEY…)' };
  }
  if (provider === 'mailjet') {
    try {
      const res = await fetch('https://api.mailjet.com/v3/REST/apikey', {
        headers: { Authorization: mailjetAuthHeader() },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, provider, error: `Mailjet API ${res.status}: ${body.slice(0, 200)}` };
      }
      return { ok: true, provider, from: mailDiagnostics().from, via: 'https (port 443)' };
    } catch (err) {
      return { ok: false, provider, error: err.message };
    }
  }
  if (provider !== 'smtp') {
    return { ok: true, provider, note: 'Fournisseur API — test SMTP non applicable' };
  }
  try {
    resetTransporter();
    const tx = getTransporter();
    if (!tx) return { ok: false, provider, error: 'Transport SMTP non initialisé' };
    await tx.verify();
    return { ok: true, provider, from: mailDiagnostics().from };
  } catch (err) {
    return { ok: false, provider, error: err.message };
  }
}

module.exports = {
  sendMail,
  sendUserInviteEmail,
  sendCompanyInviteEmail,
  sendPasswordResetEmail,
  sendDocumentSignatureEmail,
  sendDocumentReminderEmail,
  buildLoginUrl,
  mailProvider,
  mailDiagnostics,
  verifyMailTransport,
  mailCredentialsHint,
  getMailjetCredentials,
};
