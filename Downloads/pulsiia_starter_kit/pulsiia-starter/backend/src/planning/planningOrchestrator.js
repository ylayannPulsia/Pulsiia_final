// ═══════════════════════════════════════════════════════════════
// PULSIIA — Orchestrateur planning hybride (3 couches)
// ═══════════════════════════════════════════════════════════════

const { addDays, format } = require('date-fns');
const { validatePlanning } = require('./constraintEngine');
const { generatePlanning, buildDefaultShiftSlots } = require('./optimizer');
const { extractIntent, explainPlanning } = require('./pulseAdapter');
const { DAY_KEYS } = require('./constraintEngine');

function fmtDate(d) {
  return format(d instanceof Date ? d : new Date(d), 'yyyy-MM-dd');
}

function mergeStructuredConstraints(structuredParams, userConstraints, employees) {
  const extra = {
    excludeEmployees: [...(structuredParams?.excludeEmployees || [])],
    priorityCoverage: [...(structuredParams?.priorityCoverage || [])],
    forceWorkDays: [...(structuredParams?.forceWorkDays || [])],
    minimizeOvertime: structuredParams?.minimizeOvertime ?? false,
    customRules: [...(structuredParams?.customRules || [])],
  };

  for (const item of userConstraints || []) {
    if (!item?.userId || !item?.text) continue;
    const emp = employees.find((e) => e.id === item.userId);
    const offDays = parseConstraintDays(item.text);
    if (offDays.length) {
      extra.excludeEmployees.push({
        employeeId: item.userId,
        name: emp ? `${emp.firstName} ${emp.lastName}` : item.userId,
        days: offDays,
      });
    } else {
      extra.customRules.push(`${emp?.firstName || item.userId}: ${item.text}`);
    }
  }

  return extra;
}

function parseConstraintDays(text) {
  const lower = String(text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const dayMap = {
    lundi: 'monday', mardi: 'tuesday', mercredi: 'wednesday', jeudi: 'thursday',
    vendredi: 'friday', samedi: 'saturday', dimanche: 'sunday',
    lun: 'monday', mar: 'tuesday', mer: 'wednesday', jeu: 'thursday',
    ven: 'friday', sam: 'saturday', dim: 'sunday',
  };
  const days = [];
  for (const [fr, en] of Object.entries(dayMap)) {
    if (lower.includes(fr)) days.push(en);
  }
  return [...new Set(days)];
}

function resolveExcludeEmployees(intent, employees) {
  const resolved = [];
  for (const ex of intent.excludeEmployees || []) {
    let empId = ex.employeeId;
    if (!empId && ex.name) {
      const nameLower = ex.name.toLowerCase();
      const found = employees.find(
        (e) => nameLower.includes(e.firstName?.toLowerCase()) || nameLower.includes(e.lastName?.toLowerCase()),
      );
      empId = found?.id;
    }
    if (empId) resolved.push({ employeeId: empId, days: ex.days || [] });
  }
  return resolved;
}

function applyExcludedDaysToEmployees(employees, extraConstraints) {
  return employees.map((emp) => {
    const excluded = [];
    for (const ex of extraConstraints.excludeEmployees || []) {
      if (ex.employeeId === emp.id) excluded.push(...(ex.days || []));
    }
    return { ...emp, _excludedDays: [...new Set(excluded)] };
  });
}

function ensurePriorityCoverageForForceDays(extraConstraints) {
  const seen = new Set(
    (extraConstraints.priorityCoverage || []).map(
      (p) => `${p.day}:${String(p.shift || 'aprem').toLowerCase()}`,
    ),
  );
  for (const day of extraConstraints.forceWorkDays || []) {
    for (const shift of ['matin', 'aprem']) {
      const key = `${day}:${shift}`;
      if (seen.has(key)) continue;
      extraConstraints.priorityCoverage.push({
        day,
        shift,
        reason: 'Couverture demandée par la DRH',
      });
      seen.add(key);
    }
  }
  return extraConstraints;
}

function buildShiftSlotsFromIntent(extraConstraints, weekStart, planningRules, employeeCount) {
  const base = buildDefaultShiftSlots(weekStart, planningRules, { employeeCount });
  for (const prio of extraConstraints.priorityCoverage || []) {
    const dayIdx = DAY_KEYS.indexOf(prio.day);
    if (dayIdx < 0) continue;
    const date = fmtDate(addDays(weekStart, dayIdx));
    const shiftType = (prio.shift || 'aprem').toUpperCase();
    const type = shiftType.includes('MAT') ? 'MATIN' : shiftType.includes('NUIT') ? 'NUIT' : 'APREM';
    base.push({
      day: prio.day,
      date,
      role: 'service',
      shift: type.toLowerCase(),
      type,
      startTime: type === 'MATIN' ? '06:00' : '14:00',
      endTime: type === 'MATIN' ? '14:00' : '22:00',
      priority: true,
      label: prio.reason || 'Priorité DRH',
    });
  }
  return base;
}

function planningResultToAiPayload(orchestratorResult) {
  const { planning, alerts, stats, explanation, valid, validation } = orchestratorResult;
  const shifts = planning?.shifts || [];
  const violations = validation?.violations || [];
  const warnings = [
    ...(validation?.warnings || []).map((w) => w.message || w),
    ...alerts.map((a) => a.message),
  ];

  const understaffed = alerts
    .filter((a) => a.type === 'UNCOVERED_SLOT')
    .map((a) => a.message);

  return {
    shifts,
    suggestions: stats?.totalOvertimeHours > 0
      ? [`${stats.totalOvertimeHours}h sup. estimées — vérifiez la pré-paie.`]
      : [],
    warnings,
    coverageAnalysis: {
      understaffedSlots: understaffed,
      overstaffedSlots: [],
      criticalGaps: alerts.filter((a) => a.severity === 'critical').map((a) => a.message),
      coverageRate: stats?.coverageRate,
    },
    summary: explanation,
    valid,
    stats,
    alerts,
  };
}

/**
 * Point d'entrée unique — modes : prompt naturel ou params structurés.
 */
async function orchestrate({
  naturalInput,
  structuredParams,
  employees,
  absences,
  weekStart,
  planningRules,
  previousShifts,
  userConstraints,
}) {
  const ws = weekStart instanceof Date ? weekStart : new Date(`${String(weekStart).slice(0, 10)}T00:00:00`);

  let extraConstraints = mergeStructuredConstraints(structuredParams, userConstraints, employees);
  let intentMeta = { usedAi: false, usage: null };

  if (naturalInput?.trim()) {
    const { intent, usedAi, usage, error } = await extractIntent(naturalInput, employees);
    intentMeta = { usedAi, usage, error };
    extraConstraints = {
      excludeEmployees: [
        ...extraConstraints.excludeEmployees,
        ...resolveExcludeEmployees(intent, employees),
      ],
      priorityCoverage: [...extraConstraints.priorityCoverage, ...(intent.priorityCoverage || [])],
      forceWorkDays: [...new Set([
        ...extraConstraints.forceWorkDays,
        ...(intent.forceWorkDays || []),
      ])],
      minimizeOvertime: intent.minimizeOvertime ?? extraConstraints.minimizeOvertime,
      customRules: [...extraConstraints.customRules, ...(intent.customRules || [])],
    };
  }

  ensurePriorityCoverageForForceDays(extraConstraints);
  const enrichedEmployees = applyExcludedDaysToEmployees(employees, extraConstraints);
  const shiftSlots = buildShiftSlotsFromIntent(extraConstraints, ws, planningRules, employees.length);

  const planningResult = generatePlanning({
    employees: enrichedEmployees,
    shifts: shiftSlots,
    absences: absences || [],
    extraConstraints,
    weekStart: ws,
    planningRules,
    previousShifts: previousShifts || [],
  });

  const validation = validatePlanning(enrichedEmployees, planningResult.planning, ws);
  if (!validation.valid) {
    planningResult.alerts.push(
      ...validation.violations.map((v) => ({
        type: 'LEGAL_VIOLATION',
        severity: 'error',
        message: v.message || String(v),
        employeeId: v.employeeId,
        date: v.date,
      })),
    );
  }

  const { explanation, usedAi: explainUsedAi, usage: explainUsage } = await explainPlanning(
    { ...planningResult, valid: validation.valid },
    naturalInput || null,
  );

  return {
    ...planningResult,
    explanation,
    valid: validation.valid,
    validation,
    extraConstraints,
    intentMeta,
    explainMeta: { usedAi: explainUsedAi, usage: explainUsage },
    mode: 'hybrid',
  };
}

module.exports = {
  orchestrate,
  planningResultToAiPayload,
  mergeStructuredConstraints,
  buildShiftSlotsFromIntent,
};
