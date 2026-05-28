const express = require('express');
const nodemailer = require('nodemailer');
const router = express.Router();

// POST /api/demo — reçoit les données du formulaire de démo et envoie un email
router.post('/', async (req, res) => {
  const { email, prenom, nom, societe, taille, message } = req.body;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email invalide.' });
  }

  const to = process.env.DEMO_EMAIL || 'contact@pulsiia.com';

  const html = `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
      <h2 style="color:#1a6b7a">Nouvelle demande de démo — Pulsiia</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:#6b7280;width:130px">Email</td><td style="padding:8px 0;font-weight:600">${email}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">Prénom</td><td style="padding:8px 0">${prenom || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">Nom</td><td style="padding:8px 0">${nom || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">Société</td><td style="padding:8px 0">${societe || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280">Taille équipe</td><td style="padding:8px 0">${taille || '—'}</td></tr>
        ${message ? `<tr><td style="padding:8px 0;color:#6b7280">Message</td><td style="padding:8px 0">${message}</td></tr>` : ''}
      </table>
      <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb">
      <p style="font-size:12px;color:#9ca3af">Envoyé depuis la landing page Pulsiia</p>
    </div>
  `;

  // Log systématiquement (utile même si l'email échoue)
  console.log('[Demo] Demande reçue :', { email, prenom, nom, societe, taille });

  // Si SMTP configuré, on tente l'envoi — mais on répond succès dans tous les cas
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      const fromAddr = process.env.SMTP_FROM || process.env.DEMO_EMAIL || 'noreply@pulsiia.com';
      await transporter.sendMail({
        from: `"Pulsiia Demo" <${fromAddr}>`,
        to,
        replyTo: email,
        subject: `Demande de démo — ${prenom || ''} ${nom || ''} (${societe || email})`.trim(),
        html,
      });

      console.log('[Demo] Email envoyé à', to);
    } catch (err) {
      // SMTP a échoué — on log l'erreur mais on ne bloque pas l'utilisateur
      console.error('[Demo] Échec envoi email (SMTP) :', err.message);
      console.error('[Demo] Vérifiez SMTP_HOST / SMTP_USER / SMTP_PASS dans .env');
    }
  } else {
    console.log('[Demo] SMTP non configuré — demande enregistrée en console uniquement.');
  }

  // Toujours répondre succès : la demande est reçue même si l'email n'est pas parti
  res.json({ ok: true });
});

module.exports = router;
