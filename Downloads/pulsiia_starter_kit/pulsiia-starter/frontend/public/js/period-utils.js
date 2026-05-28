// period-utils.js — Périodes hebdomadaires pré-paie (lundi = YYYY-MM-DD)
(function (global) {
  'use strict';

  const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH_RE = /^\d{4}-\d{2}$/;

  function getMonday(d) {
    const x = new Date(d);
    const day = x.getDay();
    x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function formatISO(d) {
    return d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
  }

  function isWeeklyPeriod(period) {
    return WEEK_RE.test(String(period || ''));
  }

  function isMonthlyPeriod(period) {
    return MONTH_RE.test(String(period || ''));
  }

  function currentWeekPeriod() {
    return formatISO(getMonday(new Date()));
  }

  function prevPeriod(period) {
    if (isWeeklyPeriod(period)) {
      const d = new Date(period + 'T12:00:00');
      d.setDate(d.getDate() - 7);
      return formatISO(d);
    }
    if (isMonthlyPeriod(period)) {
      const [y, m] = period.split('-').map(Number);
      const d = new Date(y, m - 2, 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
    return currentWeekPeriod();
  }

  function nextPeriod(period) {
    if (isWeeklyPeriod(period)) {
      const d = new Date(period + 'T12:00:00');
      d.setDate(d.getDate() + 7);
      return formatISO(d);
    }
    if (isMonthlyPeriod(period)) {
      const [y, m] = period.split('-').map(Number);
      const d = new Date(y, m, 1);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    }
    return currentWeekPeriod();
  }

  function periodLabel(period) {
    if (isWeeklyPeriod(period)) {
      const start = new Date(period + 'T12:00:00');
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      const opts = { day: 'numeric', month: 'short' };
      const a = start.toLocaleDateString('fr-FR', opts);
      const b = end.toLocaleDateString('fr-FR', { ...opts, year: 'numeric' });
      return 'Semaine du ' + a + ' au ' + b;
    }
    if (isMonthlyPeriod(period)) {
      const [y, m] = period.split('-').map(Number);
      const label = new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    return 'Période';
  }

  function weekRangeLabel(period) {
    if (!isWeeklyPeriod(period)) return periodLabel(period);
    const start = new Date(period + 'T12:00:00');
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const fmt = function (d) {
      return d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
    };
    return fmt(start) + ' → ' + fmt(end);
  }

  function monthFromWeekPeriod(weekPeriod) {
    if (!isWeeklyPeriod(weekPeriod)) return weekPeriod;
    return weekPeriod.slice(0, 7);
  }

  function weekPeriodFromOffset(offset, baseMonday) {
    const base = baseMonday ? new Date(baseMonday) : getMonday(new Date());
    const d = new Date(base);
    d.setDate(d.getDate() + (offset || 0) * 7);
    return formatISO(d);
  }

  global.PeriodUtils = {
    getMonday,
    formatISO,
    isWeeklyPeriod,
    isMonthlyPeriod,
    currentWeekPeriod,
    prevPeriod,
    nextPeriod,
    periodLabel,
    weekRangeLabel,
    monthFromWeekPeriod,
    weekPeriodFromOffset,
  };
})(typeof window !== 'undefined' ? window : global);
