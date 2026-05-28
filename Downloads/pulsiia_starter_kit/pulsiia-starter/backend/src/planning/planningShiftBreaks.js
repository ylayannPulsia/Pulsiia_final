// Utilitaires coupures (plusieurs shifts/jour) et pauses pour le planning IA

const DEFAULT_BREAK_POLICY = {
  enabled: true,
  defaultBreakMin: 30,
  minShiftMinutesForBreak: 360,
};

const DEFAULT_SPLIT_SHIFTS = {
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
    {
      segments: [
        { start: '09:00', end: '13:00' },
        { start: '17:00', end: '21:00' },
      ],
      breakStart: '13:00',
      breakEnd: '17:00',
    },
  ],
};

function parseTimeToMin(str) {
  if (!str || typeof str !== 'string') return null;
  const [h, m] = str.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minToTime(totalMin) {
  const h = Math.floor(totalMin / 60) % 24;
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function grossMinutes(startTime, endTime) {
  const s = parseTimeToMin(startTime);
  let e = parseTimeToMin(endTime);
  if (s == null || e == null) return 0;
  if (e <= s) e += 24 * 60;
  return Math.max(0, e - s);
}

function segmentBreakMinutes(shift) {
  if (!shift) return 0;
  if (shift.breakStart && shift.breakEnd) {
    let bs = parseTimeToMin(shift.breakStart);
    let be = parseTimeToMin(shift.breakEnd);
    if (bs == null || be == null) return 0;
    if (be <= bs) be += 24 * 60;
    return Math.max(0, be - bs);
  }
  if (shift.breakMin != null && shift.breakMin > 0) return shift.breakMin;
  return 0;
}

function shiftNetMinutes(shift) {
  if (!shift || shift.type === 'OFF' || shift.type === 'ABSENT') return 0;
  if (!shift.startTime || !shift.endTime) {
    const defaults = { MATIN: 480, APREM: 480, NUIT: 480, JOURNEE: 540 };
    return defaults[shift.type] || 0;
  }
  return Math.max(0, grossMinutes(shift.startTime, shift.endTime) - segmentBreakMinutes(shift));
}

function breakPolicyFromRules(planningRules) {
  return {
    ...DEFAULT_BREAK_POLICY,
    ...(planningRules?.breakPolicy || {}),
  };
}

function splitConfigFromRules(planningRules) {
  return {
    ...DEFAULT_SPLIT_SHIFTS,
    ...(planningRules?.splitShifts || {}),
  };
}

/** Ajoute une pause par défaut si le créneau le justifie. */
function applyBreakToShift(shift, planningRules) {
  if (!shift || shift.type === 'OFF' || shift.type === 'ABSENT') return shift;
  if (!shift.startTime || !shift.endTime) return shift;

  const policy = breakPolicyFromRules(planningRules);
  if (!policy.enabled) return shift;

  const gross = grossMinutes(shift.startTime, shift.endTime);
  if (gross < (policy.minShiftMinutesForBreak || 360)) return shift;
  if (segmentBreakMinutes(shift) > 0) return shift;

  const breakMin = policy.defaultBreakMin || 30;
  const mid = parseTimeToMin(shift.startTime) + Math.floor(gross / 2) - Math.floor(breakMin / 2);
  const breakStart = minToTime(Math.max(0, mid));
  const breakEnd = minToTime(Math.max(0, mid + breakMin));

  return {
    ...shift,
    breakMin,
    breakStart,
    breakEnd,
    notes: shift.notes || 'Pause planifiée automatiquement',
  };
}

function departmentLabel(employee) {
  const pole = (employee?.secondaryRoles && employee.secondaryRoles[0]) || '';
  if (pole) return pole;
  const j = (employee?.jobTitle || '').toLowerCase();
  if (j.includes('cuisin') || j.includes('chef')) return 'Cuisine';
  if (j.includes('serve') || j.includes('sommelier')) return 'Service';
  return employee?.department || 'Service';
}

function shouldUseSplitShift(slot, planningRules, employee) {
  const split = splitConfigFromRules(planningRules);
  if (!split.enabled) return false;
  if (slot?.type !== 'JOURNEE' && slot?.shift !== 'journee') {
    const preferSplitTypes = slot?.priority && (slot.type === 'APREM' || slot.type === 'MATIN');
    if (!preferSplitTypes) return false;
  }
  const dept = departmentLabel(employee);
  const prefer = split.preferForDepartments || [];
  if (prefer.length && !prefer.some((d) => dept.toLowerCase().includes(String(d).toLowerCase()))) {
    return false;
  }
  return true;
}

function pickSplitPattern(planningRules, slot) {
  const split = splitConfigFromRules(planningRules);
  const patterns = split.patterns || DEFAULT_SPLIT_SHIFTS.patterns;
  if (!patterns.length) return null;
  const hour = parseInt((slot?.startTime || '12:00').split(':')[0], 10);
  if (hour >= 17) return patterns[0];
  if (hour < 12) return patterns[1] || patterns[0];
  return patterns[0];
}

/** Transforme un créneau en 2 shifts JOURNEE (coupure). */
function buildSplitShiftsFromSlot(slot, employee, planningRules, baseMeta = {}) {
  const pattern = pickSplitPattern(planningRules, slot);
  if (!pattern?.segments?.length) return null;

  return pattern.segments.map((seg, idx) => {
    const shift = {
      employeeId: employee.id,
      date: slot.date,
      type: 'JOURNEE',
      startTime: seg.start,
      endTime: seg.end,
      aiConfidence: baseMeta.aiConfidence ?? 0.82,
      notes: baseMeta.notes || (idx === 0 ? 'Coupure — matinée' : 'Coupure — soirée'),
    };
    if (idx === 0 && pattern.breakStart && pattern.breakEnd) {
      shift.breakStart = pattern.breakStart;
      shift.breakEnd = pattern.breakEnd;
      shift.breakMin = grossMinutes(pattern.breakStart, pattern.breakEnd);
    } else {
      return applyBreakToShift(shift, planningRules);
    }
    return shift;
  });
}

function enrichShiftsWithBreaks(shifts, planningRules) {
  return (shifts || []).map((s) => applyBreakToShift(s, planningRules));
}

function dailyNetMinutesForEmployee(employeeId, date, shifts) {
  return (shifts || [])
    .filter((s) => s.employeeId === employeeId && s.date === date && s.type !== 'OFF' && s.type !== 'ABSENT')
    .reduce((acc, s) => acc + shiftNetMinutes(s), 0);
}

function sortShiftsChronologically(shifts) {
  return [...(shifts || [])].sort((a, b) => {
    const d = a.date.localeCompare(b.date);
    if (d !== 0) return d;
    const ta = parseTimeToMin(a.startTime) ?? 0;
    const tb = parseTimeToMin(b.startTime) ?? 0;
    return ta - tb;
  });
}

module.exports = {
  DEFAULT_BREAK_POLICY,
  DEFAULT_SPLIT_SHIFTS,
  parseTimeToMin,
  minToTime,
  grossMinutes,
  segmentBreakMinutes,
  shiftNetMinutes,
  applyBreakToShift,
  shouldUseSplitShift,
  buildSplitShiftsFromSlot,
  enrichShiftsWithBreaks,
  dailyNetMinutesForEmployee,
  sortShiftsChronologically,
  breakPolicyFromRules,
  splitConfigFromRules,
};
