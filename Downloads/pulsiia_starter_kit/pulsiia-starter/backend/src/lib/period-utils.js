// Périodes pré-paie / feuilles d'heures — semaine (YYYY-MM-DD = lundi) ou mois (YYYY-MM)
const {
  addDays, subDays, format, parseISO, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, isValid,
} = require('date-fns');
const { fr } = require('date-fns/locale');

const WEEK_PERIOD_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PERIOD_REGEX = /^\d{4}-\d{2}$/;

function isWeeklyPeriod(period) {
  return WEEK_PERIOD_REGEX.test(String(period || ''));
}

function isMonthlyPeriod(period) {
  return MONTH_PERIOD_REGEX.test(String(period || ''));
}

function assertValidPeriod(period) {
  if (!isWeeklyPeriod(period) && !isMonthlyPeriod(period)) {
    throw new Error(`Période invalide : ${period}`);
  }
}

function currentPeriod() {
  return format(startOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

function weekPeriodFromDate(date) {
  return format(startOfWeek(date, { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

function periodBoundsDates(period) {
  if (isWeeklyPeriod(period)) {
    const start = startOfWeek(parseISO(period), { weekStartsOn: 1 });
    return { start, end: endOfWeek(start, { weekStartsOn: 1 }) };
  }
  if (isMonthlyPeriod(period)) {
    const [y, m] = period.split('-').map(Number);
    const start = startOfMonth(new Date(y, m - 1, 1));
    return { start, end: endOfMonth(start) };
  }
  throw new Error(`Période invalide : ${period}`);
}

function periodBoundsStrings(period) {
  const { start, end } = periodBoundsDates(period);
  return { start: format(start, 'yyyy-MM-dd'), end: format(end, 'yyyy-MM-dd') };
}

function prevPeriod(period) {
  assertValidPeriod(period);
  if (isWeeklyPeriod(period)) {
    return format(subDays(parseISO(period), 7), 'yyyy-MM-dd');
  }
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function nextPeriod(period) {
  assertValidPeriod(period);
  if (isWeeklyPeriod(period)) {
    return format(addDays(parseISO(period), 7), 'yyyy-MM-dd');
  }
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function periodLabel(period) {
  if (isWeeklyPeriod(period)) {
    const start = parseISO(period);
    if (!isValid(start)) return 'Semaine';
    const end = addDays(start, 6);
    const a = format(start, 'd MMM', { locale: fr });
    const b = format(end, 'd MMM yyyy', { locale: fr });
    return `Semaine du ${a} au ${b}`;
  }
  if (isMonthlyPeriod(period)) {
    const [y, m] = period.split('-').map(Number);
    const label = format(new Date(y, m - 1, 1), 'MMMM yyyy', { locale: fr });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  return 'Période';
}

function monthFromWeekPeriod(weekPeriod) {
  if (!isWeeklyPeriod(weekPeriod)) return weekPeriod;
  return weekPeriod.slice(0, 7);
}

function weekPeriodsOverlappingMonth(monthPeriod) {
  if (!isMonthlyPeriod(monthPeriod)) return [];
  const { start: monthStart, end: monthEnd } = periodBoundsDates(monthPeriod);
  const periods = [];
  let monday = startOfWeek(monthStart, { weekStartsOn: 1 });
  while (monday <= monthEnd) {
    const sunday = addDays(monday, 6);
    if (sunday >= monthStart && monday <= monthEnd) {
      periods.push(format(monday, 'yyyy-MM-dd'));
    }
    monday = addDays(monday, 7);
  }
  return periods;
}

function hsThresholdForPeriod(period) {
  return isWeeklyPeriod(period) ? 12 : 20;
}

module.exports = {
  WEEK_PERIOD_REGEX,
  MONTH_PERIOD_REGEX,
  isWeeklyPeriod,
  isMonthlyPeriod,
  currentPeriod,
  weekPeriodFromDate,
  periodBoundsDates,
  periodBoundsStrings,
  prevPeriod,
  nextPeriod,
  periodLabel,
  monthFromWeekPeriod,
  weekPeriodsOverlappingMonth,
  hsThresholdForPeriod,
};
