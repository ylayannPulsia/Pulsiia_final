// ═══════════════════════════════════════════════════════════════
// PULSIIA — Couche 2 : Optimiseur de planning (algorithme glouton)
// ═══════════════════════════════════════════════════════════════

const { addDays, format } = require('date-fns');
const {
  validateShift,
  weeklyHours,
  CHR_RULES,
  isWorkShift,
  DAY_KEYS,
} = require('./constraintEngine');
const {
  applyBreakToShift,
  shouldUseSplitShift,
  buildSplitShiftsFromSlot,
  shiftNetMinutes,
} = require('./planningShiftBreaks');

const SHIFT_TEMPLATES = {
  MATIN: { type: 'MATIN', startTime: '06:00', endTime: '14:00' },
  APREM: { type: 'APREM', startTime: '14:00', endTime: '22:00' },
  NUIT: { type: 'NUIT', startTime: '22:00', endTime: '06:00' },
  JOURNEE: { type: 'JOURNEE', startTime: '09:00', endTime: '18:00' },
};

const ROLE_MAP = {
  cuisine: 'Cuisine',
  service: 'Service',
  accueil: 'Accueil',
  plonge: 'Plonge',
};

function fmtDate(d) {
  return format(d instanceof Date ? d : new Date(d), 'yyyy-MM-dd');
}

function normalizeRole(dept) {
  const d = String(dept || '').toLowerCase();
  if (d.includes('cuisin') || d.includes('chef') || d.includes('pâtiss')) return 'cuisine';
  if (d.includes('serve') || d.includes('sommelier') || d.includes('barman')) return 'service';
  if (d.includes('accueil') || d.includes('hôte')) return 'accueil';
  if (d.includes('plong')) return 'plonge';
  return 'service';
}

function buildDefaultShiftSlots(weekStart, planningRules, options = {}) {
  const employeeCount = Math.max(1, options.employeeCount || 10);
  const ws = weekStart instanceof Date ? weekStart : new Date(`${String(weekStart).slice(0, 10)}T00:00:00`);
  const slots = [];

  // Adapter le nombre de postes à la taille réelle de l'équipe (évite 130+ alertes avec 7 personnes)
  const slotsPerDay = Math.min(employeeCount, Math.max(2, Math.ceil(employeeCount * 0.85)));
  const matinCount = Math.ceil(slotsPerDay / 2);
  const apremCount = Math.floor(slotsPerDay / 2);
  const roles = ['service', 'cuisine', 'accueil'];

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    const day = DAY_KEYS[dayIdx];
    const date = fmtDate(addDays(ws, dayIdx));
    let roleIdx = 0;

    for (let r = 0; r < matinCount; r++) {
      const tpl = SHIFT_TEMPLATES.MATIN;
      slots.push({
        day, date, role: roles[roleIdx % roles.length], shift: 'matin',
        startTime: tpl.startTime, endTime: tpl.endTime, type: 'MATIN',
      });
      roleIdx += 1;
    }
    for (let r = 0; r < apremCount; r++) {
      const tpl = SHIFT_TEMPLATES.APREM;
      slots.push({
        day, date, role: roles[roleIdx % roles.length], shift: 'aprem',
        startTime: tpl.startTime, endTime: tpl.endTime, type: 'APREM',
      });
      roleIdx += 1;
    }
  }

  // Créneaux critiques : uniquement lun–ven, plafonnés
  if (employeeCount >= 8) {
    for (const crit of planningRules?.criticalSlots || []) {
      const time = crit.time || '12:00';
      const minStaffCrit = Math.min(crit.minStaff || 2, Math.ceil(employeeCount / 3));
      for (let dayIdx = 0; dayIdx < 5; dayIdx++) {
        const date = fmtDate(addDays(ws, dayIdx));
        const hour = parseInt(time.split(':')[0], 10);
        const period = hour < 14 ? 'MATIN' : 'APREM';
        const tpl = SHIFT_TEMPLATES[period];
        for (let r = 0; r < minStaffCrit; r++) {
          slots.push({
            day: DAY_KEYS[dayIdx], date, role: 'service', shift: period.toLowerCase(),
            startTime: tpl.startTime, endTime: tpl.endTime, type: period,
            priority: true, label: crit.label,
          });
        }
      }
    }
  }

  return slots;
}

function isEmployeeAbsent(employee, dateStr) {
  return (employee.absences || []).some((a) => {
    const start = fmtDate(a.startDate);
    const end = fmtDate(a.endDate);
    return dateStr >= start && dateStr <= end;
  });
}

function isDayExcluded(employee, dayKey, extraConstraints) {
  const excluded = extraConstraints?.excludeEmployees || [];
  for (const ex of excluded) {
    const id = ex.employeeId || ex.userId;
    if (id === employee.id && (ex.days || []).includes(dayKey)) return true;
  }
  if (employee._excludedDays?.includes(dayKey)) return true;
  return false;
}

function countConsecutiveWorkDays(existingShifts, employeeId, beforeDate) {
  const sorted = (existingShifts || [])
    .filter((s) => s.employeeId === employeeId && isWorkShift(s) && s.date < beforeDate)
    .sort((a, b) => b.date.localeCompare(a.date));
  let count = 0;
  let prev = beforeDate;
  for (const s of sorted) {
    const expected = fmtDate(addDays(new Date(`${prev}T00:00:00`), -1));
    if (s.date === expected) {
      count += 1;
      prev = s.date;
    } else break;
  }
  return count;
}

/**
 * Score un candidat pour un créneau.
 */
function scoreEmployee(employee, slot, weeklyState, extraConstraints, existingShifts) {
  let score = 0;
  const empRole = normalizeRole(employee.department || employee.jobTitle);
  const slotRole = slot.role || 'service';

  const shiftProposal = {
    employeeId: employee.id,
    date: slot.date,
    ...SHIFT_TEMPLATES[slot.type] || SHIFT_TEMPLATES.MATIN,
  };

  const validation = validateShift(
    employee,
    shiftProposal,
    [...existingShifts, ...(weeklyState.plannedShifts || [])],
    weeklyState.weekStart,
  );
  if (!validation.valid) return -1000;

  if (isEmployeeAbsent(employee, slot.date)) return -1000;
  if (isDayExcluded(employee, slot.day, extraConstraints)) return -1000;

  const alreadyThatDay = (weeklyState.plannedShifts || []).filter(
    (s) => s.employeeId === employee.id && s.date === slot.date && isWorkShift(s),
  );
  const splitAllowed = shouldUseSplitShift(slot, weeklyState.planningRules, employee);
  if (alreadyThatDay.length && !splitAllowed) return -500;
  if (alreadyThatDay.length >= 2) return -500;

  if (employee.availability?.[slot.day] !== false) score += 50;

  const currentHours = weeklyState.hours[employee.id] || 0;
  const shiftH = shiftNetMinutes(shiftProposal) / 60 || 8;
  if (currentHours + shiftH <= (employee.weeklyHours || CHR_RULES.LEGAL_WEEKLY_HOURS)) score += 30;
  else if (currentHours + shiftH <= CHR_RULES.LEGAL_WEEKLY_HOURS) score += 10;
  else score -= 20;

  if (empRole === slotRole || (employee.competences || []).some((c) => String(c).toLowerCase().includes(slotRole))) {
    score += 20;
  }

  const avgHours = weeklyState.avgHours || CHR_RULES.LEGAL_WEEKLY_HOURS;
  if (currentHours < avgHours) score += 15;

  const pref = employee.shiftPreference || employee.preferences?.shift;
  if (pref && slot.shift === pref) score += 10;

  const consecutive = countConsecutiveWorkDays(existingShifts, employee.id, slot.date);
  if (consecutive >= 5) score -= 30;

  if (slot.priority) score += 25;
  if ((extraConstraints?.forceWorkDays || []).includes(slot.day)) score += 40;
  if (extraConstraints?.minimizeOvertime && currentHours >= CHR_RULES.LEGAL_WEEKLY_HOURS) score -= 25;

  if (employee.wellbeingScore != null && employee.wellbeingScore < 5 && slot.type === 'NUIT') score -= 40;

  return score;
}

function computeStats(planning, employees) {
  const shifts = planning?.shifts || [];
  const workShifts = shifts.filter(isWorkShift);
  const totalSlots = planning._totalSlots || workShifts.length;
  const filled = workShifts.length;
  const achievable = Math.min(totalSlots, employees.length * 5);
  const coverageRate = achievable
    ? Math.min(100, Math.round((filled / achievable) * 100))
    : 100;

  let totalOT = 0;
  let totalCostFactor = 0;
  const loadByEmployee = {};

  for (const emp of employees || []) {
    const empShifts = shifts.filter((s) => s.employeeId === emp.id);
    const h = weeklyHours(empShifts);
    loadByEmployee[emp.id] = h;
    if (h > CHR_RULES.LEGAL_WEEKLY_HOURS) totalOT += h - CHR_RULES.LEGAL_WEEKLY_HOURS;
    totalCostFactor += h;
  }

  const loads = Object.values(loadByEmployee);
  const equity = loads.length
    ? 1 - (Math.max(...loads) - Math.min(...loads)) / (CHR_RULES.MAX_WEEKLY_HOURS || 48)
    : 1;

  return {
    totalShifts: workShifts.length,
    coverageRate,
    totalOvertimeHours: +totalOT.toFixed(1),
    estimatedCostIndex: +totalCostFactor.toFixed(1),
    equityScore: +Math.max(0, equity).toFixed(2),
    loadByEmployee,
  };
}

/**
 * Génère un planning complet pour une semaine.
 */
function generatePlanning({
  employees,
  shifts: shiftSlots,
  absences,
  extraConstraints,
  weekStart,
  planningRules,
  previousShifts,
}) {
  const ws = weekStart instanceof Date ? weekStart : new Date(`${String(weekStart).slice(0, 10)}T00:00:00`);
  const slots = shiftSlots?.length
    ? shiftSlots
    : buildDefaultShiftSlots(ws, planningRules);

  const alerts = [];
  const plannedShifts = [];
  const weeklyState = {
    weekStart: ws,
    hours: {},
    plannedShifts: [],
    planningRules: planningRules || {},
    avgHours: employees.length
      ? employees.reduce((a, e) => a + (e.weeklyHours || CHR_RULES.LEGAL_WEEKLY_HOURS), 0) / employees.length
      : CHR_RULES.LEGAL_WEEKLY_HOURS,
  };

  for (const emp of employees) {
    weeklyState.hours[emp.id] = 0;
    if (absences) emp.absences = absences.filter((a) => a.userId === emp.id);
  }

  const sortedSlots = [...slots].sort((a, b) => {
    if (a.priority && !b.priority) return -1;
    if (!a.priority && b.priority) return 1;
    return a.date.localeCompare(b.date);
  });

  for (const slot of sortedSlots) {
    let best = null;
    let bestScore = -Infinity;

    for (const emp of employees) {
      const sc = scoreEmployee(emp, slot, weeklyState, extraConstraints, [...(previousShifts || []), ...plannedShifts]);
      if (sc > bestScore) {
        bestScore = sc;
        best = emp;
      }
    }

    if (!best || bestScore < 0) {
      alerts.push({
        type: 'UNCOVERED_SLOT',
        severity: slot.priority ? 'critical' : 'warning',
        date: slot.date,
        day: slot.day,
        role: slot.role,
        shift: slot.type,
        message: `Poste non couvert : ${slot.role} ${slot.type} le ${slot.day} (${slot.date}).`,
      });
      continue;
    }

    const tpl = SHIFT_TEMPLATES[slot.type] || SHIFT_TEMPLATES.MATIN;
    const useSplit = shouldUseSplitShift(slot, planningRules, best)
      && !(weeklyState.plannedShifts || []).some((s) => s.employeeId === best.id && s.date === slot.date && isWorkShift(s));

    let created = [];
    if (useSplit) {
      const splitShifts = buildSplitShiftsFromSlot(slot, best, planningRules, {
        aiConfidence: Math.min(0.95, 0.7 + bestScore / 200),
        notes: slot.label || 'Coupure service',
      });
      if (splitShifts?.length) created = splitShifts;
    }

    if (!created.length) {
      created = [applyBreakToShift({
        employeeId: best.id,
        date: slot.date,
        type: tpl.type,
        startTime: tpl.startTime,
        endTime: tpl.endTime,
        aiConfidence: Math.min(0.95, 0.7 + bestScore / 200),
        notes: slot.label || null,
      }, planningRules)];
    }

    for (const shift of created) {
      plannedShifts.push(shift);
      weeklyState.plannedShifts.push(shift);
      weeklyState.hours[best.id] = (weeklyState.hours[best.id] || 0) + shiftNetMinutes(shift) / 60;
    }
  }

  const fullShifts = ensureFullWeek(plannedShifts, employees, ws, extraConstraints);
  const withForced = applyForceWorkDays(
    fullShifts,
    employees,
    ws,
    extraConstraints,
    previousShifts,
  );
  const planning = { shifts: withForced, _totalSlots: slots.length };

  return {
    planning,
    alerts,
    stats: computeStats(planning, employees),
  };
}

/** Complète la semaine avec OFF / ABSENT pour chaque salarié. */
function ensureFullWeek(workShifts, employees, weekStart, extraConstraints) {
  const out = [...(workShifts || [])].filter((s) => isWorkShift(s) || s.type === 'ABSENT');
  const hasDayEntry = new Set(out.map((s) => `${s.employeeId}|${s.date}`));

  for (const emp of employees) {
    for (let i = 0; i < 7; i++) {
      const date = fmtDate(addDays(weekStart, i));
      const day = DAY_KEYS[i];
      const key = `${emp.id}|${date}`;
      if (hasDayEntry.has(key)) continue;

      if (isEmployeeAbsent(emp, date)) {
        out.push({ employeeId: emp.id, date, type: 'ABSENT', startTime: null, endTime: null, aiConfidence: 0.95 });
      } else if (isDayExcluded(emp, day, extraConstraints)) {
        out.push({
          employeeId: emp.id,
          date,
          type: 'OFF',
          startTime: null,
          endTime: null,
          aiConfidence: 0.95,
          notes: 'Contrainte RH appliquée',
        });
      } else {
        out.push({ employeeId: emp.id, date, type: 'OFF', startTime: null, endTime: null, aiConfidence: 0.85 });
      }
      hasDayEntry.add(key);
    }
  }

  return out;
}

/** Force des shifts sur les jours demandés par la DRH (ex. « travail jeudi–samedi »). */
function applyForceWorkDays(fullShifts, employees, weekStart, extraConstraints, previousShifts) {
  const forceDays = extraConstraints?.forceWorkDays || [];
  if (!forceDays.length) return fullShifts;

  const shifts = fullShifts.map((s) => ({ ...s }));
  const types = ['MATIN', 'APREM'];

  function weeklyHoursFor(empId) {
    return shifts
      .filter((s) => s.employeeId === empId && isWorkShift(s))
      .reduce((acc, s) => acc + shiftNetMinutes(s) / 60, 0);
  }

  for (const dayKey of forceDays) {
    const dayIdx = DAY_KEYS.indexOf(dayKey);
    if (dayIdx < 0) continue;
    const date = fmtDate(addDays(weekStart, dayIdx));

    let workCount = shifts.filter((s) => s.date === date && isWorkShift(s)).length;
    const minTarget = Math.min(
      employees.length,
      Math.max(2, Math.ceil(employees.length * 0.5)),
    );

    const sortedEmps = [...employees].sort(
      (a, b) => weeklyHoursFor(a.id) - weeklyHoursFor(b.id),
    );

    let rotate = workCount;
    for (const emp of sortedEmps) {
      if (workCount >= minTarget) break;

      const hasWork = shifts.some((s) => s.employeeId === emp.id && s.date === date && isWorkShift(s));
      if (hasWork) continue;

      const offIdx = shifts.findIndex((s) => s.employeeId === emp.id && s.date === date && s.type === 'OFF');
      if (offIdx < 0) continue;
      if (isEmployeeAbsent(emp, date)) continue;
      if (isDayExcluded(emp, dayKey, extraConstraints)) continue;

      const type = types[rotate % types.length];
      rotate += 1;
      const tpl = SHIFT_TEMPLATES[type];
      const proposal = applyBreakToShift({
        employeeId: emp.id,
        date,
        type: tpl.type,
        startTime: tpl.startTime,
        endTime: tpl.endTime,
      }, extraConstraints?.planningRules);
      const others = shifts.filter((s) => s.employeeId === emp.id && !(s.date === date && s === shifts[offIdx]));
      const { valid } = validateShift(emp, proposal, [...others, ...(previousShifts || [])], weekStart);
      if (valid) {
        shifts[offIdx] = {
          ...proposal,
          aiConfidence: 0.9,
          notes: 'Journée travaillée (demande DRH)',
        };
        workCount += 1;
      }
    }
  }

  return shifts;
}

module.exports = {
  generatePlanning,
  scoreEmployee,
  computeStats,
  buildDefaultShiftSlots,
  applyForceWorkDays,
  SHIFT_TEMPLATES,
};
