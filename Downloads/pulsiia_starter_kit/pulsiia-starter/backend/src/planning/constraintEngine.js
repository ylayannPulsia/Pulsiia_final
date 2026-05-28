// ═══════════════════════════════════════════════════════════════
// PULSIIA — Couche 1 : Moteur de contraintes légales CHR
// Garantit la conformité Code du travail + convention CHR
// ═══════════════════════════════════════════════════════════════

const { differenceInMinutes, parseISO, addDays, format } = require('date-fns');
const { shiftNetMinutes, grossMinutes } = require('./planningShiftBreaks');

function envFloat(key, fallback) {
  const v = parseFloat(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

const CHR_RULES = {
  MIN_DAILY_REST: 11 * 60,
  MAX_DAILY_AMPLITUDE: 13 * 60,
  MIN_WEEKLY_REST: 35 * 60,
  MAX_WEEKLY_HOURS: envFloat('PLANNING_MAX_WEEKLY_HOURS', 48),
  LEGAL_WEEKLY_HOURS: envFloat('PLANNING_LEGAL_WEEKLY_HOURS', 35),
  MAX_DAILY_HOURS: 10,
  NIGHT_START: 21,
  NIGHT_END: 6,
  OT_RATE_1: envFloat('PLANNING_OT_RATE_1', 1.25),
  OT_RATE_2: envFloat('PLANNING_OT_RATE_2', 1.5),
  NIGHT_RATE: envFloat('PLANNING_NIGHT_SURCHARGE', 1.2),
  SUNDAY_RATE: 1.1,
};

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function parseTimeToMinutes(timeStr, dateStr) {
  if (!timeStr || !dateStr) return null;
  const d = parseISO(`${dateStr}T${timeStr}:00`);
  return d.getHours() * 60 + d.getMinutes();
}

function shiftEndDateTime(shift) {
  if (!shift.startTime || !shift.endTime || !shift.date) return null;
  const start = parseISO(`${shift.date}T${shift.startTime}:00`);
  let end = parseISO(`${shift.date}T${shift.endTime}:00`);
  if (end <= start) end = addDays(end, 1);
  return { start, end };
}

function shiftDurationMinutes(shift) {
  if (shift.type === 'OFF' || shift.type === 'ABSENT') return 0;
  return shiftNetMinutes(shift);
}

function sameDayShifts(employeeId, date, shifts) {
  return (shifts || [])
    .filter((s) => s.employeeId === employeeId && s.date === date && isWorkShift(s))
    .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
}

function isWorkShift(shift) {
  return shift && shift.type !== 'OFF' && shift.type !== 'ABSENT';
}

/** Repos entre deux shifts consécutifs (minutes). */
function checkDailyRest(shiftA, shiftB) {
  const a = shiftEndDateTime(shiftA);
  const b = shiftEndDateTime(shiftB);
  if (!a || !b) return CHR_RULES.MIN_DAILY_REST;
  const restMin = differenceInMinutes(b.start, a.end);
  return restMin;
}

function dayKeyFromDate(dateStr, weekStart) {
  if (!dateStr || !weekStart) return null;
  const d = parseISO(`${dateStr.slice(0, 10)}T00:00:00`);
  const ws = weekStart instanceof Date ? weekStart : parseISO(`${String(weekStart).slice(0, 10)}T00:00:00`);
  const diff = Math.round((d - ws) / (24 * 60 * 60 * 1000));
  if (diff < 0 || diff > 6) return null;
  return DAY_KEYS[diff];
}

/** Heures travaillées sur une liste de shifts (semaine). */
function weeklyHours(shifts) {
  const mins = (shifts || []).filter(isWorkShift).reduce((acc, s) => acc + shiftDurationMinutes(s), 0);
  return mins / 60;
}

/** Majorations applicables sur un shift. */
function detectSurcharges(shift) {
  const surcharges = { night: false, sunday: false, overtime: 0, rates: [] };
  if (!isWorkShift(shift)) return surcharges;

  const span = shiftEndDateTime(shift);
  if (span) {
    const day = span.start.getDay();
    if (day === 0) {
      surcharges.sunday = true;
      surcharges.rates.push({ type: 'SUNDAY', rate: CHR_RULES.SUNDAY_RATE });
    }
    const startMin = span.start.getHours() * 60 + span.start.getMinutes();
    const endMin = span.end.getHours() * 60 + span.end.getMinutes();
    const nightStart = CHR_RULES.NIGHT_START * 60;
    const nightEnd = CHR_RULES.NIGHT_END * 60;
    const overlapsNight = startMin >= nightStart || startMin < nightEnd
      || endMin > nightStart || shift.type === 'NUIT';
    if (overlapsNight || shift.type === 'NUIT') {
      surcharges.night = true;
      surcharges.rates.push({ type: 'NIGHT', rate: CHR_RULES.NIGHT_RATE });
    }
  }

  return surcharges;
}

function overtimeHours(totalWeeklyHours) {
  if (totalWeeklyHours <= CHR_RULES.LEGAL_WEEKLY_HOURS) return { ot125: 0, ot150: 0 };
  const over = totalWeeklyHours - CHR_RULES.LEGAL_WEEKLY_HOURS;
  const ot125 = Math.min(over, 8);
  const ot150 = Math.max(0, over - 8);
  return { ot125, ot150 };
}

/**
 * Valide un shift proposé pour un salarié.
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateShift(employee, shift, existingShifts, weekStart) {
  const violations = [];
  if (!shift || !isWorkShift(shift)) return { valid: true, violations };

  const durationMin = shiftDurationMinutes(shift);
  const durationH = durationMin / 60;

  const sameDay = sameDayShifts(shift.employeeId, shift.date, [...(existingShifts || []), shift]);
  const dailyNetMin = sameDay.reduce((acc, s) => acc + shiftDurationMinutes(s), 0);
  const dailyNetH = dailyNetMin / 60;

  if (sameDay.length <= 1 && durationH > CHR_RULES.MAX_DAILY_HOURS) {
    violations.push(`Durée journalière ${durationH.toFixed(1)}h > max ${CHR_RULES.MAX_DAILY_HOURS}h (Code travail).`);
  }
  if (sameDay.length > 1 && dailyNetH > CHR_RULES.MAX_DAILY_HOURS) {
    violations.push(`Total journalier (coupure) ${dailyNetH.toFixed(1)}h > max ${CHR_RULES.MAX_DAILY_HOURS}h.`);
  }

  if (shift.startTime && shift.endTime) {
    const amplitudeMin = grossMinutes(shift.startTime, shift.endTime);
    if (sameDay.length <= 1 && amplitudeMin > CHR_RULES.MAX_DAILY_AMPLITUDE) {
      violations.push(`Amplitude ${(amplitudeMin / 60).toFixed(1)}h > max 13h (convention CHR).`);
    }
  }

  const sameEmployee = (existingShifts || []).filter((s) => s.employeeId === shift.employeeId);
  const dayShifts = [...sameEmployee, shift]
    .filter(isWorkShift)
    .sort((a, b) => {
      const d = a.date.localeCompare(b.date);
      if (d !== 0) return d;
      return (a.startTime || '').localeCompare(b.startTime || '');
    });

  for (let i = 0; i < dayShifts.length - 1; i++) {
    const cur = dayShifts[i];
    const nxt = dayShifts[i + 1];
    if (cur.date === nxt.date) {
      if (!cur.endTime || !nxt.startTime) continue;
      const gapMin = grossMinutes(cur.endTime, nxt.startTime);
      if (gapMin > 0 && gapMin < 30) {
        violations.push(`Pause insuffisante (${gapMin} min) entre deux créneaux le ${cur.date}.`);
      }
      continue;
    }
    const restMin = checkDailyRest(cur, nxt);
    if (restMin < CHR_RULES.MIN_DAILY_REST && restMin >= 0) {
      violations.push(
        `Repos insuffisant (${(restMin / 60).toFixed(1)}h < 11h) entre ${cur.date} et ${nxt.date}.`,
      );
    }
  }

  const weekShifts = [
    ...sameEmployee.filter((s) => !(s.date === shift.date && s.startTime === shift.startTime && s.endTime === shift.endTime)),
    shift,
  ];
  const weekTotal = weeklyHours(weekShifts);
  if (weekTotal > CHR_RULES.MAX_WEEKLY_HOURS) {
    violations.push(`${employee?.firstName || 'Salarié'} : ${weekTotal.toFixed(1)}h/semaine > max ${CHR_RULES.MAX_WEEKLY_HOURS}h.`);
  }

  let consecutive = 0;
  const workedDates = new Set(
    [...(existingShifts || []).filter((s) => s.employeeId === shift.employeeId), shift]
      .filter(isWorkShift)
      .map((s) => s.date),
  );
  const sortedDates = [...workedDates].sort();
  for (const dateStr of sortedDates) {
    consecutive += 1;
    if (consecutive > 6) {
      violations.push(`Plus de 6 jours consécutifs travaillés (à partir du ${dateStr}).`);
      break;
    }
    const nextDay = format(addDays(parseISO(`${dateStr}T00:00:00`), 1), 'yyyy-MM-dd');
    if (!workedDates.has(nextDay)) consecutive = 0;
  }

  if (employee?.absences?.length) {
    const absent = employee.absences.some((a) => {
      const start = format(a.startDate instanceof Date ? a.startDate : parseISO(String(a.startDate)), 'yyyy-MM-dd');
      const end = format(a.endDate instanceof Date ? a.endDate : parseISO(String(a.endDate)), 'yyyy-MM-dd');
      return shift.date >= start && shift.date <= end;
    });
    if (absent) violations.push(`Absence enregistrée le ${shift.date}.`);
  }

  if (weekStart && employee?.planningConstraint) {
    const dayKey = dayKeyFromDate(shift.date, weekStart);
    const excluded = (employee._excludedDays || []);
    if (dayKey && excluded.includes(dayKey)) {
      violations.push(`Contrainte RH : indisponible le ${dayKey}.`);
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Point d'entrée — valide un planning complet.
 * En cas de conflit entre règles, la règle la plus favorable au salarié prime.
 */
function validatePlanning(employees, proposedPlanning, weekStart) {
  const violations = [];
  const warnings = [];
  const surcharges = [];
  const shifts = proposedPlanning?.shifts || proposedPlanning || [];
  const employeeById = new Map((employees || []).map((e) => [e.id || e.employeeId, e]));

  for (const shift of shifts.filter(isWorkShift)) {
    const emp = employeeById.get(shift.employeeId);
    const others = shifts.filter((s) => s.employeeId === shift.employeeId && s !== shift);
    const { valid, violations: v } = validateShift(emp, shift, others, weekStart);
    if (!valid) violations.push(...v.map((msg) => ({ employeeId: shift.employeeId, date: shift.date, message: msg })));
    surcharges.push({ employeeId: shift.employeeId, date: shift.date, ...detectSurcharges(shift) });
  }

  const byEmployee = {};
  for (const s of shifts) {
    if (!byEmployee[s.employeeId]) byEmployee[s.employeeId] = [];
    byEmployee[s.employeeId].push(s);
  }
  for (const [empId, list] of Object.entries(byEmployee)) {
    const total = weeklyHours(list);
    const emp = employeeById.get(empId);
    const target = emp?.weeklyHours || CHR_RULES.LEGAL_WEEKLY_HOURS;
    if (total > CHR_RULES.LEGAL_WEEKLY_HOURS && total <= CHR_RULES.MAX_WEEKLY_HOURS) {
      const { ot125, ot150 } = overtimeHours(total);
      warnings.push({
        employeeId: empId,
        message: `${emp?.firstName || empId} : ${total.toFixed(1)}h (${ot125.toFixed(1)}h à ×1.25, ${ot150.toFixed(1)}h à ×1.50).`,
      });
    }
    if (total > target * 1.1 && total <= CHR_RULES.LEGAL_WEEKLY_HOURS) {
      warnings.push({
        employeeId: empId,
        message: `${emp?.firstName || empId} : ${total.toFixed(1)}h planifiées (contrat ${target}h).`,
      });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    warnings,
    surcharges,
  };
}

module.exports = {
  CHR_RULES,
  validateShift,
  validatePlanning,
  checkDailyRest,
  weeklyHours,
  detectSurcharges,
  shiftDurationMinutes,
  isWorkShift,
  DAY_KEYS,
};
