// Rapport ROI complet — PDF minimal (sans dépendance externe)
const { createSimplePdf } = require('./timesheet-pdf');
const { periodLongLabel } = require('./roi-engine');

function formatEuros(n) {
  return `${Math.round(n || 0).toLocaleString('fr-FR')} €`;
}

function buildRoiCompletPdf(report, opts = {}) {
  const scopeLabel = opts.managerScope || report.managerScope ? 'Mon équipe' : 'Entreprise';
  const c = report.current || {};
  const period = report.periodLabel || periodLongLabel(report.period) || report.period;

  const kpiRows = [
    `Économies totales : ${formatEuros(c.eurosSaved)}`,
    `Heures RH récupérées : ${c.rhHoursDisplay || c.rhHoursSaved || 0}`,
    `Erreurs paie évitées : ${c.errorsAvoided ?? 0}`,
    c.roiMultiplier != null
      ? `ROI mensuel : ${c.roiMultiplier >= 1 ? '×' + c.roiMultiplier : c.roiMultiplier + '×'}`
      : 'ROI mensuel : —',
    c.subscriptionCost
      ? `Coût abonnement (prorata) : ${formatEuros(c.subscriptionCost)}`
      : null,
    c.coveredEmployees ? `Collaborateurs couverts : ${c.coveredEmployees}` : null,
  ].filter(Boolean);

  const monthlyRows = (report.monthly || []).map((m) =>
    `${m.label} — cumul ${formatEuros(m.avecPulsiia)} · gain mois ${formatEuros(m.monthlyGainEuros)}`,
  );

  const leverRows = (report.levers || []).map((l) =>
    `${l.label} : +${formatEuros(l.gainEuros)} (${l.measure})`,
  );
  if (report.totalGainEuros != null) {
    leverRows.push(`Total mensuel : ${formatEuros(report.totalGainEuros)}`);
  }

  const methodology = report.methodology?.estimated || [];
  const footerLines = [
    `Période ${period} · Périmètre ${scopeLabel}`,
    'Données issues du moteur ROI Pulsiia (pré-paie, absences, planning).',
    `Généré le ${new Date().toLocaleString('fr-FR')} · Confidentiel RH`,
  ];

  return createSimplePdf({
    title: 'Rapport ROI complet — Pulsiia',
    subtitle: `${period} · ${scopeLabel}`,
    sections: [
      { heading: 'Indicateurs clés', rows: kpiRows },
      { heading: 'Évolution 6 mois (cumul)', rows: monthlyRows.length ? monthlyRows : ['Aucune donnée sur la période'] },
      { heading: 'Synthèse par levier', rows: leverRows.length ? leverRows : ['Aucun levier mesurable sur la période'] },
      methodology.length
        ? { heading: 'Méthode (extraits)', rows: methodology.slice(0, 5) }
        : null,
    ].filter(Boolean),
    footerLines,
  });
}

module.exports = { buildRoiCompletPdf };
