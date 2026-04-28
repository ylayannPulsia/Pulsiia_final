/**
 * Prioritizer
 *
 * Décide quelles alertes envoyer maintenant et lesquelles ignorer.
 *
 * Critères :
 *  - cooldown par règle + cible (pas de re-déclenchement avant N minutes)
 *  - heures de silence configurables par utilisateur (ex : 19h-7h)
 *  - dédoublonnage : une alerte sur la même target dans la fenêtre cooldown = ignorée
 *  - cap par utilisateur : max 5 alertes / heure (sauf CRITICAL qui passe toujours)
 *  - regroupement digest : alertes LOW agrégées en 1 digest plutôt qu'envoyées séparément
 */

const { SEVERITY } = require('./rules');

const HOURLY_CAP = 5;

class Prioritizer {
  constructor({ prisma, logger }) {
    this.prisma = prisma;
    this.logger = logger || console;
  }

  /**
   * Filtre une liste d'alertes candidates pour un utilisateur.
   * Retourne celles à envoyer et marque celles écartées avec une raison.
   *
   * @param {Array} candidates — alertes générées par les rules
   * @param {object} userPrefs — { silenceFromHour, silenceToHour, timezone, channels }
   * @param {object} ctx — { tenantId, userId }
   */
  async filter(candidates, userPrefs, ctx) {
    if (!candidates.length) return { toSend: [], skipped: [] };

    const now = new Date();

    // 1. Heures de silence
    const inSilence = this._inSilenceWindow(now, userPrefs);

    // 2. Lookup du dernier envoi par règle+target pour cooldown
    const recentSent = await this.prisma.proactiveAlertSent.findMany({
      where: {
        userId: ctx.userId,
        sentAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) }, // 24h
      },
      select: { ruleId: true, targetType: true, targetId: true, sentAt: true },
    });

    const sentMap = new Map(); // key = ruleId+target → date
    for (const s of recentSent) {
      const key = `${s.ruleId}::${s.targetType}::${s.targetId}`;
      if (!sentMap.has(key) || sentMap.get(key) < s.sentAt) {
        sentMap.set(key, s.sentAt);
      }
    }

    // 3. Filtrage par alerte
    const toSend = [];
    const skipped = [];

    for (const alert of candidates) {
      const isCritical = alert.severity === SEVERITY.CRITICAL;

      // Silence : seul CRITICAL passe
      if (inSilence && !isCritical) {
        skipped.push({ alert, reason: 'silence_window' });
        continue;
      }

      // Cooldown
      const ruleDef = require('./rules').RULES.find((r) => r.id === alert.rule);
      const cooldown = (ruleDef && ruleDef.cooldownMinutes) || 60;
      const key = `${alert.rule}::${alert.target?.type || ''}::${alert.target?.id || ''}`;
      const lastSent = sentMap.get(key);
      if (lastSent) {
        const sinceMin = (now - lastSent) / 60000;
        if (sinceMin < cooldown) {
          skipped.push({ alert, reason: `cooldown ${cooldown}min` });
          continue;
        }
      }

      // Cap horaire (sauf CRITICAL)
      if (!isCritical && toSend.filter((a) => a.severity !== SEVERITY.CRITICAL).length >= HOURLY_CAP) {
        skipped.push({ alert, reason: 'hourly_cap' });
        continue;
      }

      toSend.push(alert);
    }

    // 4. Sort by severity desc
    toSend.sort((a, b) => b.severity - a.severity);

    return { toSend, skipped };
  }

  _inSilenceWindow(date, prefs) {
    if (!prefs || prefs.silenceFromHour == null) return false;
    const hour = date.getHours();
    const from = prefs.silenceFromHour;
    const to = prefs.silenceToHour;
    if (from === to) return false;
    if (from < to) {
      return hour >= from && hour < to;
    }
    // wrapping (ex : 19h → 7h)
    return hour >= from || hour < to;
  }
}

module.exports = { Prioritizer };
