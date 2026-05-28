// mon-salaire-api.js — Page « Mon salaire » branchée sur l'API pré-paie
(function () {
  'use strict';

  let loading = false;
  let lastSalaryData = null;

  const PAY_TYPE_LABELS = {
    HEURE_NORMALE: 'Heure normale',
    HEURE_SUP_125: 'Heures supp. ×1.25',
    HEURE_SUP_150: 'Heures supp. ×1.50',
    MAJORATION_NUIT: 'Majoration nuit ×1.20',
    MAJORATION_DIMANCHE: 'Majoration dimanche',
    MAJORATION_FERIE: 'Majoration férié',
    ABSENCE_MALADIE: 'Absence maladie',
    CONGES_PAYES: 'Congés payés',
    PRIME_ANCIENNETE: 'Prime ancienneté',
    PRIME_PERFORMANCE: 'Prime performance',
    PRIME_PANIER: 'Prime panier',
    REMBOURSEMENT_TRANSPORT: 'Remboursement transport',
    AVANTAGE_NATURE: 'Avantage en nature',
    AUTRE: 'Autre',
  };

  const PAY_STATUS = {
    A_VALIDER: { label: 'À valider', cls: 'warn' },
    VALIDE: { label: 'Validé', cls: 'ok' },
    ANOMALIE: { label: 'Anomalie IA', cls: 'error' },
    REJETE: { label: 'Rejeté', cls: '', bg: '#F3F4F6', color: '#6B7280', dot: '#6B7280' },
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

  function formatEuro(n) {
    if (n == null || Number.isNaN(n)) return '—';
    return Number(n).toFixed(2).replace('.', ',') + ' €';
  }

  function formatPeriodLabel(period) {
    if (!period) return '';
    const parts = period.split('-').map(Number);
    const label = new Date(parts[0], parts[1] - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function formatVariableValue(v) {
    const val = Math.abs(v.value);
    const sign = v.value < 0 ? '−' : '+';
    if (v.unit === '€') return sign + val.toFixed(2).replace('.', ',') + ' €';
    if (v.unit === 'jours') return sign + val + ' j';
    return sign + val + 'h';
  }

  function setInput(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val != null ? val : 0;
  }

  function renderSalaryForm(data) {
    if (!data) return;

    setInput('sal-taux', data.hourlyRate);
    setInput('sal-h-norm', data.hours?.normal ?? 0);
    setInput('sal-h-nuit', data.hours?.night ?? 0);
    setInput('sal-h-sup125', data.hours?.sup125 ?? 0);
    setInput('sal-h-sup150', data.hours?.sup150 ?? 0);
    setInput('sal-prime', data.prime ?? 0);

    if (typeof calcSalaire === 'function') calcSalaire();

    const brutEl = document.getElementById('sal-result-brut');
    const netEl = document.getElementById('sal-result-net');
    if (brutEl && data.brut != null) brutEl.textContent = formatEuro(data.brut);
    if (netEl && data.net != null) netEl.textContent = formatEuro(data.net);

    const hintEl = document.getElementById('sal-taux-hint');
    if (hintEl) {
      if (data.hourlyRateFromProfile) {
        hintEl.style.display = 'block';
        hintEl.textContent = 'Taux renseigné par les RH sur votre fiche collaborateur.';
      } else {
        hintEl.style.display = 'block';
        hintEl.textContent = 'Taux société par défaut — les RH peuvent le personnaliser dans Collaborateurs.';
      }
    }
  }

  function renderSubtitle(period) {
    const el = document.getElementById('sal-page-subtitle');
    if (!el) return;
    if (period) {
      el.textContent = 'Variables de paie · ' + formatPeriodLabel(period) + ' · Données live';
    } else {
      el.textContent = 'Simulateur · Basé sur vos variables de paie · Données indicatives';
    }
  }

  function renderPayVariables(variables) {
    const el = document.getElementById('sal-variables-list');
    if (!el) return;

    const rows = variables || [];
    if (!rows.length) {
      el.innerHTML = '<div style="padding:20px;font-size:13px;color:var(--text-3);text-align:center">Aucune variable de paie pour cette période</div>';
      return;
    }

    el.innerHTML = rows.map(function (v, idx) {
      const typeLabel = PAY_TYPE_LABELS[v.type] || v.type || '—';
      const status = PAY_STATUS[v.status] || PAY_STATUS.A_VALIDER;
      const isLast = idx === rows.length - 1;
      const border = isLast ? '' : 'border-bottom:1px solid var(--border);';
      const badgeStyle = status.bg
        ? 'background:' + status.bg + ';color:' + status.color
        : '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;' + border + 'font-size:13px">' +
        '<span><strong>' + escapeHtml(typeLabel) + '</strong></span>' +
        '<span style="font-family:monospace;font-weight:600;margin:0 16px">' + escapeHtml(formatVariableValue(v)) + '</span>' +
        '<span class="status-badge ' + status.cls + '"' + (badgeStyle ? ' style="' + badgeStyle + '"' : '') + '>' +
        '<span class="status-dot"' + (status.dot ? ' style="background:' + status.dot + '"' : '') + '></span>' +
        escapeHtml(status.label) + '</span></div>';
    }).join('');
  }

  function bulletinPeriodLabel(doc) {
    const fromName = (doc.name || '')
      .replace(/^Bulletin de paie — /i, '')
      .replace(/^Bulletin /i, '')
      .trim();
    if (fromName && fromName !== doc.name) return fromName;
    if (doc.date) {
      const d = new Date(doc.date + 'T12:00:00');
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      }
    }
    return doc.name || '—';
  }

  function renderBulletinHistory(documents) {
    const tbody = document.getElementById('sal-bulletins-tbody');
    if (!tbody) return;

    const bulletins = (documents || []).filter(function (d) { return d.cat === 'bulletin'; });
    if (!bulletins.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:20px;font-size:13px;color:var(--text-3);text-align:center">Aucun bulletin disponible</td></tr>';
      return;
    }

    tbody.innerHTML = bulletins.map(function (d, idx) {
      const period = bulletinPeriodLabel(d);
      const isLast = idx === bulletins.length - 1;
      const border = isLast ? '' : 'border-bottom:1px solid var(--border);';
      return '<tr>' +
        '<td style="padding:12px 16px;font-size:13px;' + border + '">' + escapeHtml(period) + '</td>' +
        '<td style="padding:12px 16px;font-size:13px;font-weight:600;' + border + '">—</td>' +
        '<td style="padding:12px 16px;font-size:13px;color:var(--green);' + border + '">—</td>' +
        '<td style="padding:12px 16px;' + border + '">' +
        '<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px" data-doc-id="' + escapeHtml(d.id) + '" onclick="downloadBulletin(this)">↓ PDF</button>' +
        '</td></tr>';
    }).join('');
  }

  function setLoading(state) {
    const el = document.getElementById('sal-loading');
    if (el) el.style.display = state ? 'block' : 'none';
  }

  async function loadMonSalaire() {
    if (typeof api === 'undefined') return;
    if (loading) return;

    loading = true;
    setLoading(true);

    const period = new Date().toISOString().slice(0, 7);

    try {
      const results = await Promise.allSettled([
        api.mySalary(period),
        api.myDocuments(),
      ]);

      const salary = results[0].status === 'fulfilled' ? results[0].value : null;
      const docs = results[1].status === 'fulfilled' ? (results[1].value.documents || []) : [];

      if (results[0].status === 'rejected') {
        console.warn('[mon-salaire-api] salary:', results[0].reason?.error || results[0].reason?.message || results[0].reason);
      }
      if (results[1].status === 'rejected') {
        console.warn('[mon-salaire-api] documents:', results[1].reason?.error || results[1].reason?.message || results[1].reason);
      }

      lastSalaryData = salary;
      window.__salaryApiData = salary;

      renderSubtitle(salary?.period);
      renderSalaryForm(salary);
      renderPayVariables(salary?.variables || []);
      renderBulletinHistory(docs);
    } catch (err) {
      console.warn('[mon-salaire-api]', err.error || err.message || err);
      renderSubtitle(null);
      if (typeof calcSalaire === 'function') calcSalaire();
    } finally {
      loading = false;
      setLoading(false);
    }
  }

  function patchShowPage() {
    if (typeof showPage !== 'function' || showPage.__monSalaireApiPatched) return;
    const orig = showPage;
    window.showPage = function (name, navEl) {
      orig(name, navEl);
      if (name === 'mon-salaire' && isCollabUser()) {
        loadMonSalaire();
      }
    };
    showPage.__monSalaireApiPatched = true;
  }

  function patchApplySession() {
    if (typeof applyAuthenticatedSession !== 'function' || applyAuthenticatedSession.__monSalairePatched) return;
    const orig = applyAuthenticatedSession;
    window.applyAuthenticatedSession = function (user) {
      orig(user);
      if (user?.role === 'COLLABORATEUR' && document.getElementById('page-mon-salaire')?.classList.contains('active')) {
        loadMonSalaire();
      }
    };
    applyAuthenticatedSession.__monSalairePatched = true;
  }

  function deferInit() {
    if (typeof showPage !== 'function') {
      setTimeout(deferInit, 40);
      return;
    }
    patchShowPage();
    patchApplySession();

    if (isCollabUser() && document.getElementById('page-mon-salaire')?.classList.contains('active')) {
      loadMonSalaire();
    }
  }

  window.loadMonSalairePage = loadMonSalaire;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', deferInit);
  } else {
    deferInit();
  }
})();
