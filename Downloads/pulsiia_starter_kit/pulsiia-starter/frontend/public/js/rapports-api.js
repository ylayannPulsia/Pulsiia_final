// rapports-api.js — Page Rapports ROI connectée à /api/reports/roi
(function () {
  'use strict';

  const REPORT_TYPE_SLUG = {
    'ROI mensuel': 'roi-mensuel',
    'Absentéisme': 'absenteisme',
    'Turnover': 'turnover',
    'Bien-être': 'bien-etre',
    'Heures supplémentaires': 'heures-sup',
    'Pré-paie': 'prepaie',
  };

  let lastReport = null;
  let loading = false;

  function getApi() {
    return window.api || window.PulsiiaApi;
  }

  function isManagerScoped() {
    return window.Auth?.user?.role === 'MANAGER' || lastReport?.managerScope === true;
  }

  function formatEuros(n) {
    return Math.round(n || 0).toLocaleString('fr-FR') + '€';
  }

  function formatDeltaEuros(n) {
    const v = Math.round(n || 0);
    if (v === 0) return 'stable vs M−1';
    return (v > 0 ? '+' : '') + v.toLocaleString('fr-FR') + '€ vs M−1';
  }

  function formatDeltaHours(h) {
    const v = Math.round((h || 0) * 60);
    if (v === 0) return 'stable vs M−1';
    const sign = v > 0 ? '+' : '';
    if (Math.abs(v) < 60) return sign + v + ' min vs M−1';
    const hh = Math.floor(Math.abs(v) / 60);
    const mm = Math.abs(v) % 60;
    return sign + hh + 'h' + (mm ? String(mm).padStart(2, '0') : '') + ' vs M−1';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function applyManagerRapportsUI() {
    if (!isManagerScoped()) return;

    const h2 = document.querySelector('#page-rapports h2');
    if (h2) h2.textContent = 'Rapports ROI — Mon équipe';

    document.querySelectorAll('#page-rapports button[onclick*="showSilaeExport"]').forEach(function (el) {
      el.style.display = 'none';
    });
  }

  function renderKpis(report) {
    const c = report.current;
    setText('rap-euros', formatEuros(c.eurosSaved));
    setText('rap-heures', c.rhHoursDisplay || (c.rhHoursSaved + 'h'));
    setText('rap-erreurs', String(c.errorsAvoided));
    setText('rap-multiplier', c.roiMultiplier != null
      ? (c.roiMultiplier >= 1 ? '×' + c.roiMultiplier : c.roiMultiplier + '×')
      : '—');
    setText('rap-euros-delta', formatDeltaEuros(c.deltas?.euros));
    setText('rap-heures-delta', formatDeltaHours(c.deltas?.rhHours));
    setText('rap-erreurs-delta', c.deltas?.errors
      ? (c.deltas.errors > 0 ? '+' : '') + c.deltas.errors + ' vs M−1'
      : 'stable vs M−1');
    setText('rap-roi-sub', c.subscriptionCost
      ? (c.roiMultiplier != null && c.roiMultiplier < 1
        ? 'du coût abo · gains cumulés dans le graphique'
        : 'vs ' + formatEuros(c.subscriptionCost) + ' abonnement')
      : 'vs coût abonnement');

    const sub = document.getElementById('rap-period-subtitle');
    if (sub) {
      const scope = report.managerScope ? ' · Équipe gérée' : ' · Entreprise';
      const covered = report.current.coveredEmployees
        ? ' · ' + report.current.coveredEmployees + ' collab. couverts'
        : '';
      sub.textContent = 'Méthode documentée · ' + (report.periodLabel || report.period) + scope + covered;
    }
  }

  function renderChart(monthly) {
    const bars = document.getElementById('roi-chart-bars');
    const lbls = document.getElementById('roi-chart-labels');
    if (!bars || !lbls || !monthly?.length) return;

    const max = Math.max(...monthly.map(function (d) {
      return Math.max(d.avecPulsiia || 0, d.sansPulsiia || 0, d.monthlyGainEuros || 0);
    }), 1);

    bars.innerHTML = monthly.map(function (d, i) {
      const cumul = d.avecPulsiia || 0;
      const hA = cumul > 0 ? Math.max(6, Math.round((cumul / max) * 140)) : 0;
      const hS = Math.max(6, Math.round(((d.sansPulsiia || 0) / max) * 140));
      const isLast = i === monthly.length - 1;
      const gainMonth = d.monthlyGainEuros || 0;
      return '<div style="flex:1;display:flex;align-items:flex-end;gap:3px;justify-content:center">' +
        '<div class="roi-bar" data-h="' + hA + '" style="flex:1;height:' + (hA || 0) + 'px;border-radius:4px 4px 0 0;background:' +
        (isLast ? 'var(--blue)' : '#BFCFFE') + ';border:1.5px solid ' + (isLast ? 'var(--blue)' : '#93C5FD') +
        ';transition:height .6s cubic-bezier(.34,1.2,.64,1) ' + (i * 0.07) + 's;cursor:pointer;min-height:0" title="' +
        escapeHtml(d.label) + ' — ' + cumul.toLocaleString('fr-FR') + '€ cumulés · +' +
        gainMonth.toLocaleString('fr-FR') + '€ ce mois"></div>' +
        '<div class="roi-bar-sans" data-h="' + hS + '" style="flex:1;height:' + hS + 'px;border-radius:4px 4px 0 0;background:#F3F4F6;border:1.5px solid #E5E7EB;transition:height .6s cubic-bezier(.34,1.2,.64,1) ' +
        (i * 0.07 + 0.04) + 's" title="Baseline sans Pulsiia : ' + (d.sansPulsiia || 0).toLocaleString('fr-FR') + '€/mois"></div>' +
        '</div>';
    }).join('');

    lbls.innerHTML = monthly.map(function (d) {
      return '<div class="rap-chart-label">' + escapeHtml(d.label) + '</div>';
    }).join('');

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.querySelectorAll('.roi-bar').forEach(function (el) {
          const h = parseInt(el.dataset.h, 10) || 0;
          el.style.height = h + 'px';
        });
        document.querySelectorAll('.roi-bar-sans').forEach(function (el) {
          el.style.height = (parseInt(el.dataset.h, 10) || 0) + 'px';
        });
      });
    });
  }

  function renderLeversTable(report) {
    const tbody = document.getElementById('roi-levers-tbody');
    if (!tbody) return;

    const levers = report.levers || [];
    if (!levers.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:16px;color:var(--text-2);font-size:13px">Aucune donnée pré-paie ou absence sur la période — synchronisez le planning pour alimenter le ROI.</td></tr>';
      return;
    }

    const rows = levers.map(function (l) {
      const kind = l.kind === 'estimated' ? ' · estimé' : '';
      return '<tr><td>' + escapeHtml(l.label) + '</td><td>' + escapeHtml(l.measure) + '</td><td>' +
        escapeHtml(l.source) + kind + '</td><td style="font-weight:700;color:var(--green)">+' +
        formatEuros(l.gainEuros) + '</td></tr>';
    }).join('');

    const total = report.totalGainEuros || report.current?.eurosSaved || 0;
    tbody.innerHTML = rows +
      '<tr style="background:var(--bg)"><td style="font-weight:700">Total mensuel</td><td></td><td></td>' +
      '<td style="font-weight:800;font-size:15px;color:var(--green)">' + formatEuros(total) + '</td></tr>';
  }

  function updateReportCards(report) {
    const periodLabel = report.periodLabel || report.period;
    document.querySelectorAll('#page-rapports .rapport-card').forEach(function (card) {
      const meta = card.querySelector('.rapport-card-meta');
      if (meta) meta.textContent = periodLabel + ' · ↓ CSV';
    });

    const silaeBtn = document.querySelector('#page-rapports button[onclick*="showSilaeExport"] div[style*="flex:1"] div:last-child');
    if (silaeBtn && !isManagerScoped()) {
      silaeBtn.textContent = (report.prepaieVariablesReady || 0) + ' variables · Format DSN natif';
    }
  }

  async function loadRapports() {
    if (loading) return;
    const api = getApi();
    if (!api?.reportsRoi) return;

    loading = true;
    try {
      const report = await api.reportsRoi({ months: 6 });
      lastReport = report;
      applyManagerRapportsUI();
      renderKpis(report);
      renderChart(report.monthly);
      renderLeversTable(report);
      updateReportCards(report);
      window._lastRoiReport = report;
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast('⚠️ ' + (err?.message || err?.error || 'Impossible de charger les rapports ROI'));
      }
    } finally {
      loading = false;
    }
  }

  function currentPeriod() {
    return lastReport?.period || new Date().toISOString().slice(0, 7);
  }

  async function downloadReport(typeLabel, options) {
    const api = getApi();
    const slug = REPORT_TYPE_SLUG[typeLabel] || 'roi-mensuel';
    if (!api?.reportsRoiExport) {
      if (typeof showToast === 'function') showToast('API rapports indisponible');
      return;
    }

    const format = options?.format || 'csv';
    const formatLabel = format === 'pdf' ? 'PDF' : format === 'excel' ? 'Excel' : 'CSV';
    if (typeof showToast === 'function') {
      showToast('📊 Génération du rapport "' + typeLabel + '" (' + formatLabel + ')…');
    }

    try {
      await api.reportsRoiExport(slug, currentPeriod(), { format });
      if (typeof showToast === 'function') showToast('✅ Rapport ' + typeLabel + ' téléchargé');
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast('⚠️ ' + (err?.message || err?.error || 'Export impossible'));
      }
    }
  }

  async function exportExcel() {
    const api = getApi();
    if (!api?.reportsRoiExport) {
      if (typeof showToast === 'function') showToast('API rapports indisponible');
      return;
    }
    if (typeof showToast === 'function') showToast('📊 Export Excel en cours…');
    try {
      await api.reportsRoiExport('roi-complet', currentPeriod(), { format: 'excel' });
      if (typeof showToast === 'function') showToast('✅ Fichier Excel téléchargé');
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast('⚠️ ' + (err?.message || err?.error || 'Export Excel impossible'));
      }
    }
  }

  async function exportPDFComplet() {
    const api = getApi();
    if (!api?.reportsRoiExport) {
      if (typeof showToast === 'function') showToast('API rapports indisponible');
      return;
    }
    if (typeof showToast === 'function') showToast('📄 Génération du PDF complet…');
    try {
      await api.reportsRoiExport('roi-complet', currentPeriod(), { format: 'pdf' });
      if (typeof showToast === 'function') showToast('✅ PDF complet téléchargé');
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast('⚠️ ' + (err?.message || err?.error || 'Export PDF impossible'));
      }
    }
  }

  function renderRapports() {
    loadRapports();
  }

  function hookShowPage() {
    const prev = window.__showPageExtras;
    window.__showPageExtras = function (name, navEl) {
      if (typeof prev === 'function') prev(name, navEl);
      if (name === 'rapports') setTimeout(renderRapports, 80);
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (!window.Auth?.isAuthenticated()) return;
    if (window.Auth?.user?.role === 'COLLABORATEUR') return;

    hookShowPage();

    document.addEventListener('click', function (e) {
      const ni = e.target.closest('.nav-item[onclick*="rapports"]');
      if (ni) setTimeout(renderRapports, 80);
    });
  });

  window.renderRapports = renderRapports;
  window.genererRapport = downloadReport;
  window.exportExcel = exportExcel;
  window.exportPDFComplet = exportPDFComplet;
  window.loadRapports = loadRapports;
})();
