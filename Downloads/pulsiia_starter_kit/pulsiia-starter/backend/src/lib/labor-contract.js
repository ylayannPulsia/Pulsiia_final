// Limites horaires par contrat + règles planning société (Code du travail / CHR)

function envFloat(key, fallback) {
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

const DEFAULT_SHIFT_TEMPLATES = {
  MATIN: { enabled: true, start: '06:00', end: '14:00', label: 'Matin' },
  APREM: { enabled: true, start: '14:00', end: '22:00', label: 'Après-midi' },
  NUIT: { enabled: true, start: '22:00', end: '06:00', label: 'Nuit' },
  JOURNEE: { enabled: true, start: '09:00', end: '18:00', label: 'Journée' },
  OFF: { enabled: true, start: null, end: null, label: 'Repos' },
  ABSENT: { enabled: true, start: null, end: null, label: 'Absent' },
};

const DEFAULT_PLANNING_RULES = {
  openingHours: { start: '06:00', end: '23:00' },
  operatingDays: [1, 2, 3, 4, 5, 6, 0],
  shiftTemplates: { ...DEFAULT_SHIFT_TEMPLATES },
  minStaffPerShift: { Cuisine: 2, Service: 3, Accueil: 1 },
  criticalSlots: [
    { time: '08:00', label: 'Service petit-déjeuner', minStaff: 2 },
    { time: '12:00', label: 'Service déjeuner', minStaff: 4 },
    { time: '19:00', label: 'Service dîner', minStaff: 4 },
  ],
  maxConsecutiveDays: 6,
  minRestBetweenShifts: 11,
  maxWeeklyHours: envFloat('PLANNING_MAX_WEEKLY_HOURS', 48),
  legalWeeklyHours: envFloat('PLANNING_LEGAL_WEEKLY_HOURS', 35),
  maxDailyHours: 10,
  breakPolicy: {
    enabled: true,
    defaultBreakMin: 30,
    minShiftMinutesForBreak: 360,
  },
  splitShifts: {
    enabled: true,
    preferForDepartments: ['Service', 'Cuisine'],
    patterns: [
      {
        segments: [
          { start: '11:00', end: '15:00' },
          { start: '18:00', end: '22:00' },
        ],
        breakStart: '15:00',
        breakEnd: '18:00',
      },
    ],
  },
};

/** Modèles de volume horaire courants (affichage UI) */
const CONTRACT_HOUR_PRESETS = [
  { hours: 35, label: '35h — Temps plein (légal)' },
  { hours: 39, label: '39h — Temps plein CHR' },
  { hours: 28, label: '28h — Temps partiel' },
  { hours: 24, label: '24h — Mi-temps' },
  { hours: 20, label: '20h — Mi-temps réduit' },
];

function mergeShiftTemplates(raw) {
  const base = { ...DEFAULT_SHIFT_TEMPLATES };
  if (!raw || typeof raw !== 'object') return base;
  for (const key of Object.keys(base)) {
    if (raw[key] && typeof raw[key] === 'object') {
      base[key] = { ...base[key], ...raw[key] };
    }
  }
  return base;
}

function normalizePlanningRules(raw) {
  const base = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
  return {
    ...DEFAULT_PLANNING_RULES,
    ...base,
    openingHours: {
      ...DEFAULT_PLANNING_RULES.openingHours,
      ...(base.openingHours || {}),
    },
    shiftTemplates: mergeShiftTemplates(base.shiftTemplates),
    minStaffPerShift: {
      ...DEFAULT_PLANNING_RULES.minStaffPerShift,
      ...(base.minStaffPerShift || {}),
    },
    criticalSlots: Array.isArray(base.criticalSlots)
      ? base.criticalSlots
      : DEFAULT_PLANNING_RULES.criticalSlots,
    operatingDays: Array.isArray(base.operatingDays)
      ? base.operatingDays.map(Number).filter((d) => d >= 0 && d <= 6)
      : DEFAULT_PLANNING_RULES.operatingDays,
    breakPolicy: {
      ...DEFAULT_PLANNING_RULES.breakPolicy,
      ...(base.breakPolicy || {}),
    },
    splitShifts: {
      ...DEFAULT_PLANNING_RULES.splitShifts,
      ...(base.splitShifts || {}),
      patterns: Array.isArray(base.splitShifts?.patterns)
        ? base.splitShifts.patterns
        : DEFAULT_PLANNING_RULES.splitShifts.patterns,
    },
  };
}

function planningRulesFromCompany(company) {
  return normalizePlanningRules(company?.settings?.planningRules);
}

/** Horaires par type de shift pour le moteur planning */
function shiftDefaultsFromRules(planningRules) {
  const rules = planningRules || DEFAULT_PLANNING_RULES;
  const templates = rules.shiftTemplates || DEFAULT_SHIFT_TEMPLATES;
  const out = {};
  for (const [type, tpl] of Object.entries(templates)) {
    out[type] = { start: tpl.start ?? null, end: tpl.end ?? null };
  }
  return out;
}

/** Durée en heures d'un type de shift (templates société) */
function shiftTemplateDurationHours(type, planningRules) {
  const tpl = (planningRules?.shiftTemplates || DEFAULT_SHIFT_TEMPLATES)[type];
  if (!tpl?.start || !tpl?.end) {
    const fallbacks = { MATIN: 8, APREM: 8, NUIT: 8, JOURNEE: 9 };
    return fallbacks[type] || 0;
  }
  const [sh, sm] = tpl.start.split(':').map(Number);
  const [eh, em] = tpl.end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
}

/**
 * Calcule les limites horaires d'un collaborateur selon son contrat et la société.
 * @returns {{
 *   contractWeeklyHours: number,
 *   legalWeeklyHours: number,
 *   maxWeeklyHoursLegal: number,
 *   maxWeeklyHoursPlanning: number,
 *   overtimeThreshold: number,
 *   isPartTime: boolean,
 * }}
 */
function computeContractLimits(user, planningRules) {
  const rules = planningRules || DEFAULT_PLANNING_RULES;
  const legalBase = rules.legalWeeklyHours ?? DEFAULT_PLANNING_RULES.legalWeeklyHours;
  const maxLegal = rules.maxWeeklyHours ?? DEFAULT_PLANNING_RULES.maxWeeklyHours;

  const contract = user?.weeklyHours != null && user.weeklyHours > 0
    ? Number(user.weeklyHours)
    : legalBase;

  const isPartTime = contract < legalBase;
  const contractType = user?.contractType || 'CDI';

  // Plafond absolu Code du travail (48h, ou paramètre société)
  let maxWeeklyHoursLegal = maxLegal;

  // Intérim : même plafond légal, alerte planning plus stricte sur le volume contrat
  let maxWeeklyHoursPlanning = maxLegal;
  if (isPartTime) {
    // Temps partiel : dépassement du contrat = heures complémentaires (max +33% en général)
    maxWeeklyHoursPlanning = Math.min(maxLegal, Math.round(contract * 1.33 * 10) / 10);
  } else if (contractType === 'INTERIM') {
    maxWeeklyHoursPlanning = Math.min(maxLegal, contract);
  }

  return {
    contractWeeklyHours: contract,
    legalWeeklyHours: legalBase,
    maxWeeklyHoursLegal,
    maxWeeklyHoursPlanning,
    overtimeThreshold: contract,
    isPartTime,
  };
}

module.exports = {
  DEFAULT_SHIFT_TEMPLATES,
  DEFAULT_PLANNING_RULES,
  CONTRACT_HOUR_PRESETS,
  normalizePlanningRules,
  planningRulesFromCompany,
  shiftDefaultsFromRules,
  shiftTemplateDurationHours,
  computeContractLimits,
};
