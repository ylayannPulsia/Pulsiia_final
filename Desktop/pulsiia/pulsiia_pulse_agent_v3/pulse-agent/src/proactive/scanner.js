/**
 * Scanner — orchestrateur de la détection proactive.
 *
 * Pour chaque utilisateur actif :
 *  1. Charge ses préférences (intervalle, silence, canaux activés)
 *  2. Exécute les règles applicables (selon l'heure, le profil, etc.)
 *  3. Filtre via Prioritizer (cooldown, silence, cap)
 *  4. Envoie via Notifier sur les canaux configurés
 *  5. Persiste le résultat
 *
 * Conçu pour s'intégrer aux 7 cron jobs existants du monorepo Pulsiia.
 * Une seule fonction publique : `runScan(opts)` à appeler par un scheduler.
 */

const { RULES } = require('./rules');
const { Prioritizer } = require('./prioritizer');

const DEFAULT_PREFS = {
  enabled: true,
  intervalMinutes: 30,
  silenceFromHour: 19,
  silenceToHour: 7,
  timezone: 'Europe/Paris',
  channels: ['websocket', 'pwa', 'email'], // par défaut, pas slack/teams sauf opt-in
};

class Scanner {
  constructor({ prisma, services, notifier, logger }) {
    this.prisma = prisma;
    this.services = services;
    this.notifier = notifier;
    this.prioritizer = new Prioritizer({ prisma, logger });
    this.logger = logger || console;
  }

  /**
   * Lance un scan complet sur tous les utilisateurs éligibles.
   * @param {object} [opts]
   * @param {boolean} [opts.includeDigest] — true uniquement entre 7h et 9h
   * @returns {Promise<{ scanned: number, alertsSent: number, perUser: Array }>}
   */
  async runScan(opts = {}) {
    const start = Date.now();
    const includeDigest = opts.includeDigest ?? this._isMorning();

    const users = await this._eligibleUsers();
    const perUser = [];
    let totalSent = 0;

    for (const user of users) {
      try {
        const prefs = { ...DEFAULT_PREFS, ...(user.alertPreferences || {}) };
        if (!prefs.enabled) continue;

        // Vérifier l'intervalle (skip si dernier scan trop récent)
        if (!this._intervalElapsed(user.lastScanAt, prefs.intervalMinutes)) continue;

        const ctx = { tenantId: user.tenantId, userId: user.id };

        // Collecte candidates
        const candidates = await this._runRules(ctx, includeDigest);

        // Filtre
        const { toSend, skipped } = await this.prioritizer.filter(candidates, prefs, ctx);

        // Envoi
        const sentResults = [];
        for (const alert of toSend) {
          const ruleDef = RULES.find((r) => r.id === alert.rule);
          // intersection canaux règle ∩ canaux utilisateur
          const channels = (ruleDef?.channels || ['websocket']).filter((c) =>
            prefs.channels.includes(c)
          );
          if (channels.length === 0) {
            sentResults.push({ alert: alert.rule, skipped: 'no enabled channel' });
            continue;
          }
          const result = await this.notifier.send(alert, user, channels);
          sentResults.push({ alert: alert.rule, channels, result });
          totalSent++;
        }

        // Update lastScanAt
        await this.prisma.user.update({
          where: { id: user.id },
          data: { lastScanAt: new Date() },
        }).catch((e) => this.logger.error('[scanner] update lastScanAt', e.message));

        perUser.push({
          userId: user.id,
          candidates: candidates.length,
          sent: sentResults.length,
          skipped: skipped.length,
        });
      } catch (err) {
        this.logger.error(`[scanner] user ${user.id} failed`, err.message);
        perUser.push({ userId: user.id, error: err.message });
      }
    }

    const duration = Date.now() - start;
    this.logger.info('[scanner] scan complete', {
      users: users.length,
      alertsSent: totalSent,
      durationMs: duration,
    });

    return {
      scanned: users.length,
      alertsSent: totalSent,
      durationMs: duration,
      perUser,
    };
  }

  // ─── private ─────────────────────────────────
  async _eligibleUsers() {
    return this.prisma.user.findMany({
      where: {
        active: true,
        role: { in: ['DRH', 'RH', 'MANAGER'] }, // pas de scan pour COLLABORATEUR
        OR: [
          { alertPreferences: { equals: null } }, // utilisateurs sans prefs = defaults
          { alertPreferences: { path: ['enabled'], equals: true } },
        ],
      },
      select: {
        id: true,
        email: true,
        prenom: true,
        nom: true,
        role: true,
        tenantId: true,
        lastScanAt: true,
        alertPreferences: true,
        slackWebhookUrl: true,
        teamsWebhookUrl: true,
      },
    });
  }

  async _runRules(ctx, includeDigest) {
    const candidates = [];
    for (const rule of RULES) {
      // Règles digest = uniquement le matin
      if (rule.id.startsWith('digest.') && !includeDigest) continue;
      try {
        const out = await rule.check(ctx, this.services);
        if (Array.isArray(out)) candidates.push(...out);
      } catch (err) {
        this.logger.warn(`[scanner] rule ${rule.id} failed`, err.message);
      }
    }
    return candidates;
  }

  _intervalElapsed(lastScanAt, intervalMinutes) {
    if (!lastScanAt) return true;
    const elapsedMin = (Date.now() - new Date(lastScanAt).getTime()) / 60000;
    return elapsedMin >= intervalMinutes;
  }

  _isMorning() {
    const h = new Date().getHours();
    return h >= 7 && h < 9;
  }
}

module.exports = { Scanner, DEFAULT_PREFS };
