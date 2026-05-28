// mon-planning-api.js — Page « Mon planning » collaborateur branchée sur l'API
(function () {
  'use strict';

  let loading = false;

  const ABS_TYPE_LABEL = {
    CP: 'Congé payé',
    RTT: 'RTT',
    MALADIE: 'Arrêt maladie',
    ACCIDENT_TRAVAIL: 'Accident du travail',
    SANS_SOLDE: 'Congé sans solde',
    FORMATION: 'Formation',
    AUTRE: 'Autre',
  };

  const ABS_STATUS_BADGE = {
    EN_ATTENTE: { label: 'En attente', cls: 'warn' },
    APPROUVE: { label: 'Approuvé', cls: 'ok' },
    REFUSE: { label: 'Refusé', cls: '', bg: '#F3F4F6', color: '#6B7280', dot: '#6B7280' },
    ANNULE: { label: 'Annulé', cls: '', bg: '#F3F4F6', color: '#6B7280', dot: '#6B7280' },
  };

  function isCollabUser() {
    const role = window.Auth?.user?.role || window.currentUser?.role;
    return role === 'COLLABORATEUR';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatAbsPeriod(start, end) {
    if (!start) return '—';
    const s = new Date(start + 'T12:00:00');
    const e = end ? new Date(end + 'T12:00:00') : s;
    const opts = { day: 'numeric', month: 'short' };
    if (s.getTime() === e.getTime()) return s.toLocaleDateString('fr-FR', opts);
    return s.toLocaleDateString('fr-FR', opts) + ' – ' + e.toLocaleDateString('fr-FR', opts);
  }

  function countAbsDays(start, end) {
    if (!start) return 0;
    const s = new Date(start + 'T12:00:00');
    const e = end ? new Date(end + 'T12:00:00') : s;
    return Math.max(1, Math.round((e - s) / 86400000) + 1);
  }

  function renderMonthlyHours(salary) {
    const valEl = document.getElementById('mon-plan-month-hours');
    const subEl = document.getElementById('mon-plan-month-sub');
    const labelEl = document.getElementById('mon-plan-month-label');
    if (!valEl) return;

    const period = salary?.period || new Date().toISOString().slice(0, 7);
    if (labelEl && period) {
      const parts = period.split('-').map(Number);
      const monthLabel = new Date(parts[0], parts[1] - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      labelEl.textContent = 'Heures ce mois-ci · ' + monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);
    }

    if (!salary?.hours) {
      valEl.innerHTML = '0<span>h</span>';
      if (subEl) subEl.textContent = 'Aucune heure enregistrée ce mois pour le moment';
      return;
    }

    const h = salary.hours;
    const total = Math.round(h.normal + h.night + h.sup125 + h.sup150);
    valEl.innerHTML = total + '<span>h</span>';

    if (subEl) {
      const parts = [];
      if (h.normal > 0) parts.push(Math.round(h.normal) + 'h normales');
      if (h.night > 0) parts.push(Math.round(h.night) + 'h nuit');
      if (h.sup125 + h.sup150 > 0) parts.push(Math.round(h.sup125 + h.sup150) + 'h sup.');
      subEl.textContent = parts.length ? parts.join(' · ') : 'Heures normales ce mois';
    }
  }

  function renderLeaveBalance(balance) {
    const valEl = document.getElementById('mon-plan-leave-balance');
    const subEl = document.getElementById('mon-plan-leave-sub');
    if (!valEl) return;

    if (!balance?.cp) {
      valEl.innerHTML = '— <span style="font-size:14px;font-weight:500;color:var(--text-3)">jours</span>';
      if (subEl) subEl.textContent = 'Solde indisponible';
      return;
    }

    const cpRem = balance.cp.remaining ?? 0;
    const rttRem = balance.rtt?.remaining ?? 0;
    const total = Math.round((cpRem + rttRem) * 10) / 10;

    valEl.innerHTML = total + ' <span style="font-size:14px;font-weight:500;color:var(--text-3)">jours</span>';
    if (subEl) {
      subEl.textContent = rttRem > 0 ? 'Dont ' + rttRem + ' RTT' : 'Congés payés restants';
    }
  }

  function renderAbsencesTable(absences) {
    const tbody = document.getElementById('mon-plan-absences-tbody');
    if (!tbody) return;

    const rows = (absences || []).slice(0, 10);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="mon-plan-leaves-empty">Aucune demande de congé pour le moment</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (a) {
      const typeLabel = ABS_TYPE_LABEL[a.type] || a.type || '—';
      const period = formatAbsPeriod(a.startDate, a.endDate);
      const days = countAbsDays(a.startDate, a.endDate);
      const status = ABS_STATUS_BADGE[a.status] || ABS_STATUS_BADGE.EN_ATTENTE;
      let badgeStyle = '';
      if (status.bg) badgeStyle = 'background:' + status.bg + ';color:' + status.color;
      const dotStyle = status.dot ? 'background:' + status.dot : '';

      return '<tr>' +
        '<td><strong style="font-weight:600">' + escapeHtml(typeLabel) + '</strong></td>' +
        '<td>' + escapeHtml(period) + '</td>' +
        '<td>' + days + ' jour' + (days > 1 ? 's' : '') + '</td>' +
        '<td>' +
        '<span class="status-badge ' + (status.cls || '') + '"' + (badgeStyle ? ' style="' + badgeStyle + '"' : '') + '>' +
        '<span class="status-dot"' + (dotStyle ? ' style="' + dotStyle + '"' : '') + '></span>' +
        escapeHtml(status.label) + '</span></td></tr>';
    }).join('');
  }

  function renderMonPlanningSafe() {
    try {
      if (typeof renderMonPlanning === 'function') renderMonPlanning();
    } catch (err) {
      console.warn('[mon-planning-api] render:', err);
    }
  }

  async function loadMonPlanningWeek(force) {
    const offset = typeof monPlanWeekOffset !== 'undefined' ? monPlanWeekOffset : 0;
    if (typeof setMonPlanGridStatus === 'function') {
      setMonPlanGridStatus('Chargement…', '');
    } else {
      const gridStatus = document.getElementById('mon-plan-grid-status');
      if (gridStatus) gridStatus.textContent = 'Chargement…';
    }

    try {
      if (typeof loadPlanningCollabsFromApi === 'function') {
        await loadPlanningCollabsFromApi(false);
      } else if (typeof ensurePlanningApiReady === 'function') {
        await ensurePlanningApiReady(false);
      }
    } catch (err) {
      console.warn('[mon-planning-api] collabs:', err.error || err.message || err);
    }
    try {
      if (typeof loadPlanningWeekFromApi === 'function') {
        await loadPlanningWeekFromApi(offset, force !== false);
      }
    } catch (err) {
      console.warn('[mon-planning-api] week:', err.error || err.message || err);
    }
    renderMonPlanningSafe();
  }

  async function loadMonPlanningApiData() {
    if (typeof api === 'undefined') return;
    const year = new Date().getFullYear();
    const period = new Date().toISOString().slice(0, 7);

    const results = await Promise.allSettled([
      api.mySalary(period),
      api.absencesBalance(null, year),
      api.absences(),
    ]);

    renderMonthlyHours(results[0].status === 'fulfilled' ? results[0].value : null);
    renderLeaveBalance(results[1].status === 'fulfilled' ? results[1].value : null);
    const absences = results[2].status === 'fulfilled' ? (results[2].value.absences || []) : [];
    window.__monPlanApprovedAbsences = absences.filter(function (a) { return a.status === 'APPROUVE'; });
    renderAbsencesTable(absences);
    renderMonPlanningSafe();
  }

  async function loadMonPlanning() {
    if (!isCollabUser()) return;
    if (loading) return;

    loading = true;
    try {
      await Promise.all([
        loadMonPlanningWeek(true),
        loadMonPlanningApiData(),
      ]);
    } catch (err) {
      console.warn('[mon-planning-api]', err.error || err.message || err);
      renderMonPlanningSafe();
    } finally {
      loading = false;
    }
  }

  function patchShowPage() {
    if (typeof showPage !== 'function' || showPage.__monPlanApiPatched) return;
    const orig = showPage;
    window.showPage = function (name, navEl) {
      orig(name, navEl);
      if (name === 'mon-planning' && isCollabUser()) {
        loadMonPlanning();
      }
    };
    showPage.__monPlanApiPatched = true;
  }

  function patchSaveDemande() {
    if (typeof saveDemande !== 'function' || window.__saveDemandeMonPlanPatched) return;
    const orig = saveDemande;
    window.saveDemande = async function () {
      const modal = document.getElementById('modal-demande');
      const wasOpen = modal?.classList.contains('open');
      await orig();
      if (wasOpen && !modal?.classList.contains('open') && isCollabUser()) {
        loadMonPlanning();
      }
    };
    window.__saveDemandeMonPlanPatched = true;
  }

  function patchApplySession() {
    if (typeof applyAuthenticatedSession !== 'function' || applyAuthenticatedSession.__monPlanPatched) return;
    const orig = applyAuthenticatedSession;
    window.applyAuthenticatedSession = function (user) {
      orig(user);
      if (user?.role === 'COLLABORATEUR' && document.getElementById('page-mon-planning')?.classList.contains('active')) {
        loadMonPlanning();
      }
    };
    applyAuthenticatedSession.__monPlanPatched = true;
  }

  function deferInit() {
    if (typeof showPage !== 'function') {
      setTimeout(deferInit, 40);
      return;
    }
    patchShowPage();
    patchSaveDemande();
    patchApplySession();

    if (isCollabUser() && document.getElementById('page-mon-planning')?.classList.contains('active')) {
      loadMonPlanning();
    }
  }

  window.loadMonPlanning = loadMonPlanning;
  window.loadMonPlanningWeek = loadMonPlanningWeek;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', deferInit);
  } else {
    deferInit();
  }
})();
