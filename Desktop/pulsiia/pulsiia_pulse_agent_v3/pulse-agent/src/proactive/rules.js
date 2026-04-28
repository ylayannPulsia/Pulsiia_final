/**
 * Detection Rules — règles métier déclenchant une alerte proactive.
 *
 * Chaque règle :
 *  - id, label, severity (LOW/MED/HIGH/CRITICAL)
 *  - check(ctx, services) → array d'alertes candidates
 *  - cooldownMinutes : pour éviter de re-déclencher trop vite
 */

const SEVERITY = Object.freeze({
  LOW: 1,
  MED: 2,
  HIGH: 3,
  CRITICAL: 4,
});

const RULES = [
  // ─── PLANNING ──────────────────────────────────
  {
    id: 'planning.uncovered_shift_24h',
    label: 'Poste découvert dans les 24h',
    severity: SEVERITY.CRITICAL,
    cooldownMinutes: 60,
    channels: ['websocket', 'email', 'pwa', 'slack'],
    async check(ctx, services) {
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 3600 * 1000);
      const uncovered = await services.planning.detectUncoveredShifts({
        tenantId: ctx.tenantId,
        from: now.toISOString().slice(0, 10),
        to: in24h.toISOString().slice(0, 10),
      });
      return (uncovered.shifts || []).map((s) => ({
        rule: 'planning.uncovered_shift_24h',
        severity: SEVERITY.CRITICAL,
        title: 'Poste découvert dans les 24h',
        body: `Poste ${s.type} ${s.heure_debut}-${s.heure_fin} non couvert le ${s.date} (${s.etablissement})`,
        action: { tool: 'suggerer_remplacement', input: { shift_id: s.id } },
        target: { type: 'shift', id: s.id },
      }));
    },
  },

  {
    id: 'planning.uncovered_shift_72h',
    label: 'Poste découvert dans les 72h',
    severity: SEVERITY.HIGH,
    cooldownMinutes: 240,
    channels: ['websocket', 'pwa', 'slack'],
    async check(ctx, services) {
      const now = new Date();
      const in72h = new Date(now.getTime() + 72 * 3600 * 1000);
      const uncovered = await services.planning.detectUncoveredShifts({
        tenantId: ctx.tenantId,
        from: now.toISOString().slice(0, 10),
        to: in72h.toISOString().slice(0, 10),
      });
      return (uncovered.shifts || [])
        // exclut ceux déjà flagués en CRITICAL (dans les 24h)
        .filter((s) => new Date(s.date).getTime() - now.getTime() > 24 * 3600 * 1000)
        .map((s) => ({
          rule: 'planning.uncovered_shift_72h',
          severity: SEVERITY.HIGH,
          title: 'Poste découvert prévu',
          body: `Poste à couvrir le ${s.date} — ${s.etablissement}`,
          action: { tool: 'suggerer_remplacement', input: { shift_id: s.id } },
          target: { type: 'shift', id: s.id },
        }));
    },
  },

  // ─── PRÉ-PAIE ──────────────────────────────────
  {
    id: 'paie.anomaly_detected',
    label: 'Anomalie paie détectée',
    severity: SEVERITY.HIGH,
    cooldownMinutes: 360,
    channels: ['websocket', 'email', 'pwa'],
    async check(ctx, services) {
      const periode = new Date().toISOString().slice(0, 7);
      const result = await services.prepaie.detectAnomalies({
        tenantId: ctx.tenantId,
        periode,
      });
      return (result.anomalies || []).map((a) => ({
        rule: 'paie.anomaly_detected',
        severity: SEVERITY.HIGH,
        title: 'Anomalie paie détectée',
        body: `${a.type} sur ${a.collaborateur || 'plusieurs lignes'} — ${a.description}`,
        action: { tool: 'detecter_anomalies_paie', input: { periode } },
        target: { type: 'variable_paie', id: a.id },
      }));
    },
  },

  {
    id: 'paie.cloture_imminente',
    label: 'Clôture paie dans 3 jours, variables non validées',
    severity: SEVERITY.MED,
    cooldownMinutes: 1440, // 1×/jour
    channels: ['websocket', 'email'],
    async check(ctx, services) {
      const status = await services.prepaie.getCloture({ tenantId: ctx.tenantId });
      if (!status || !status.dateCloture) return [];

      const daysToCloture =
        (new Date(status.dateCloture) - Date.now()) / (24 * 3600 * 1000);

      if (daysToCloture > 3 || daysToCloture < 0) return [];
      if (status.aValiderCount === 0) return [];

      return [
        {
          rule: 'paie.cloture_imminente',
          severity: SEVERITY.MED,
          title: `Clôture paie dans ${Math.ceil(daysToCloture)}j`,
          body: `${status.aValiderCount} variables encore à valider avant la clôture du ${status.dateCloture}`,
          action: { tool: 'lister_variables_paie', input: { periode: status.periode, statut: 'a_valider' } },
          target: { type: 'cloture', id: status.periode },
        },
      ];
    },
  },

  // ─── BIEN-ÊTRE ─────────────────────────────────
  {
    id: 'bienetre.score_drop',
    label: 'Chute du score bien-être équipe',
    severity: SEVERITY.HIGH,
    cooldownMinutes: 1440, // 1×/jour
    channels: ['websocket', 'email', 'pwa'],
    async check(ctx, services) {
      const equipes = await services.bienetre.listTeamsWithScoreDrop({
        tenantId: ctx.tenantId,
        thresholdDrop: 1.0, // chute ≥ 1 point
        windowDays: 14,
      });
      return (equipes || []).map((eq) => ({
        rule: 'bienetre.score_drop',
        severity: SEVERITY.HIGH,
        title: `Bien-être en baisse : ${eq.nom}`,
        body: `Score passé de ${eq.scorePrecedent.toFixed(1)} à ${eq.scoreActuel.toFixed(1)} (-${(eq.scorePrecedent - eq.scoreActuel).toFixed(1)} pts)`,
        action: { tool: 'analyser_bienetre_equipe', input: { equipe_id: eq.id } },
        target: { type: 'equipe', id: eq.id },
      }));
    },
  },

  {
    id: 'bienetre.turnover_risk',
    label: 'Risque de turnover élevé détecté',
    severity: SEVERITY.HIGH,
    cooldownMinutes: 4320, // 3 jours
    channels: ['websocket', 'email'],
    async check(ctx, services) {
      const risks = await services.bienetre.listHighTurnoverRisks({
        tenantId: ctx.tenantId,
        threshold: 0.7,
      });
      return (risks || []).map((r) => ({
        rule: 'bienetre.turnover_risk',
        severity: SEVERITY.HIGH,
        title: `Risque turnover élevé : ${r.equipeNom}`,
        body: `Score risque ${(r.score * 100).toFixed(0)}% — facteurs : ${(r.facteurs || []).join(', ')}`,
        action: { tool: 'predire_turnover', input: { equipe_id: r.equipeId } },
        target: { type: 'equipe', id: r.equipeId },
      }));
    },
  },

  // ─── DIGEST MATIN ──────────────────────────────
  {
    id: 'digest.morning',
    label: 'Digest matinal',
    severity: SEVERITY.LOW,
    cooldownMinutes: 1440, // 1×/jour
    channels: ['email', 'pwa'],
    triggerHourLocal: 8, // déclenché uniquement entre 7h et 9h locale
    async check(ctx, services) {
      const today = new Date().toISOString().slice(0, 10);
      const [planning, paie, roi] = await Promise.all([
        services.planning.getDailySummary({ tenantId: ctx.tenantId, date: today }),
        services.prepaie.getStatus({ tenantId: ctx.tenantId }),
        services.roi.computeMonthly({ tenantId: ctx.tenantId, periode: today.slice(0, 7) }),
      ]);
      return [
        {
          rule: 'digest.morning',
          severity: SEVERITY.LOW,
          title: 'Votre matinée Pulsiia',
          body:
            `Aujourd'hui : ${planning.shiftsCount || 0} shifts planifiés, ` +
            `${planning.uncoveredCount || 0} postes à couvrir. ` +
            `Paie : ${paie.aValiderCount || 0} variables à valider. ` +
            `ROI mensuel : ${(roi.economies_eur || 0).toLocaleString('fr-FR')}€ économisés.`,
          target: { type: 'digest', id: today },
        },
      ];
    },
  },
];

module.exports = { RULES, SEVERITY };
