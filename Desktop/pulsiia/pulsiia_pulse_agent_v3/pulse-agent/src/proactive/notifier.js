/**
 * Notifier — multi-canal
 *
 * Délivre une alerte via les canaux configurés :
 *  - websocket : push in-app temps réel (via socket.io ou ws du monorepo)
 *  - email     : Resend ou SendGrid (déjà intégrés dans le monorepo)
 *  - pwa       : Web Push API (VAPID, déjà en place)
 *  - slack     : webhook Slack
 *  - teams     : webhook Teams (incoming webhook)
 *
 * Chaque adapter est injecté pour rester découplé du monorepo.
 */

class Notifier {
  /**
   * @param {object} adapters
   * @param {object} adapters.websocket — { send(userId, payload) }
   * @param {object} adapters.email     — { send({to, subject, html}) }
   * @param {object} adapters.pwa       — { push(userId, payload) }
   * @param {object} adapters.slack     — { send(webhookUrl, payload) }
   * @param {object} adapters.teams     — { send(webhookUrl, payload) }
   * @param {object} prisma
   * @param {object} logger
   */
  constructor({ adapters, prisma, logger }) {
    this.adapters = adapters || {};
    this.prisma = prisma;
    this.logger = logger || console;
  }

  /**
   * Envoie une alerte à un utilisateur via les canaux demandés.
   * @param {object} alert — { rule, severity, title, body, action, target }
   * @param {object} user — { id, email, slackWebhookUrl, teamsWebhookUrl, ... }
   * @param {Array<string>} channels — sous-ensemble de ['websocket','email','pwa','slack','teams']
   */
  async send(alert, user, channels) {
    const results = {};

    const tasks = channels.map(async (ch) => {
      try {
        const adapter = this.adapters[ch];
        if (!adapter) {
          results[ch] = { ok: false, error: 'adapter manquant' };
          return;
        }

        switch (ch) {
          case 'websocket':
            await adapter.send(user.id, this._payloadInApp(alert));
            break;
          case 'email':
            await adapter.send({
              to: user.email,
              subject: this._severityPrefix(alert.severity) + alert.title,
              html: this._renderEmailHtml(alert, user),
            });
            break;
          case 'pwa':
            await adapter.push(user.id, this._payloadInApp(alert));
            break;
          case 'slack':
            if (!user.slackWebhookUrl) {
              results[ch] = { ok: false, error: 'webhook Slack non configuré' };
              return;
            }
            await adapter.send(user.slackWebhookUrl, this._payloadSlack(alert));
            break;
          case 'teams':
            if (!user.teamsWebhookUrl) {
              results[ch] = { ok: false, error: 'webhook Teams non configuré' };
              return;
            }
            await adapter.send(user.teamsWebhookUrl, this._payloadTeams(alert));
            break;
          default:
            results[ch] = { ok: false, error: 'canal inconnu' };
            return;
        }
        results[ch] = { ok: true };
      } catch (err) {
        this.logger.error(`[notifier] ${ch} failed`, err.message);
        results[ch] = { ok: false, error: err.message };
      }
    });

    await Promise.all(tasks);

    // Persiste l'envoi pour cooldown / audit
    if (this.prisma) {
      try {
        await this.prisma.proactiveAlertSent.create({
          data: {
            userId: user.id,
            tenantId: user.tenantId,
            ruleId: alert.rule,
            severity: alert.severity,
            title: alert.title,
            body: alert.body,
            targetType: alert.target?.type || null,
            targetId: alert.target?.id || null,
            channels: JSON.stringify(channels),
            results: JSON.stringify(results),
            sentAt: new Date(),
          },
        });
      } catch (err) {
        this.logger.error('[notifier] persist failed', err.message);
      }
    }

    return results;
  }

  // ─── Payloads par canal ──────────────────────
  _payloadInApp(alert) {
    return {
      type: 'pulse.proactive_alert',
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      action: alert.action || null,
      target: alert.target || null,
      timestamp: new Date().toISOString(),
    };
  }

  _payloadSlack(alert) {
    const emoji = ['', '🟢', '🟡', '🟠', '🔴'][alert.severity] || '🔵';
    return {
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: `${emoji} ${alert.title}` },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: alert.body },
        },
        ...(alert.action
          ? [
              {
                type: 'context',
                elements: [
                  { type: 'mrkdwn', text: `_Pulse propose : ${alert.action.tool}_` },
                ],
              },
            ]
          : []),
      ],
    };
  }

  _payloadTeams(alert) {
    const colors = ['', '00A86B', 'F0AD4E', 'FF8800', 'D13438'];
    return {
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: alert.title,
      themeColor: colors[alert.severity] || '0076D7',
      title: alert.title,
      text: alert.body,
    };
  }

  _severityPrefix(severity) {
    return ['', '', '', '⚠️ ', '🚨 '][severity] || '';
  }

  _renderEmailHtml(alert, user) {
    const colors = ['#0F1117', '#059669', '#D97706', '#EA580C', '#DC2626'];
    const color = colors[alert.severity] || '#2563EB';
    return `<!doctype html><html><body style="margin:0;background:#F7F8FA;font-family:Arial,sans-serif">
  <div style="max-width:560px;margin:32px auto;background:white;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.07)">
    <div style="background:${color};padding:18px 24px;color:white">
      <div style="font-size:13px;opacity:.85;letter-spacing:.5px">PULSIIA · ALERTE PROACTIVE</div>
      <div style="font-size:18px;font-weight:600;margin-top:4px">${escape(alert.title)}</div>
    </div>
    <div style="padding:24px;color:#111827">
      <p style="font-size:15px;line-height:1.5;margin:0 0 16px">Bonjour ${escape(user.prenom || '')},</p>
      <p style="font-size:14px;line-height:1.55;color:#374151">${escape(alert.body)}</p>
      ${
        alert.action
          ? `<p style="margin-top:24px"><a href="https://app.pulsiia.com" style="display:inline-block;background:#2563EB;color:white;padding:10px 18px;border-radius:7px;text-decoration:none;font-weight:500;font-size:14px">Voir dans Pulsiia →</a></p>`
          : ''
      }
    </div>
    <div style="padding:14px 24px;background:#FAFBFC;color:#9CA3AF;font-size:11px;border-top:1px solid #E5E7EB">
      Vous recevez ce message car les alertes proactives sont activées dans votre espace Pulsiia.
      <a href="https://app.pulsiia.com/settings/alerts" style="color:#6B7280">Gérer mes préférences</a>
    </div>
  </div>
</body></html>`;
  }
}

function escape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { Notifier };
