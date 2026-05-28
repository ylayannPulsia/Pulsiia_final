// feuille-heure-api.js — Feuilles d'heures & signature Yousign (pré-paie + collaborateur)
(function () {
  'use strict';

  let fhData = null;
  let fhLoading = false;
  let fhSelected = new Set();

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getPeriod() {
    if (typeof ppPeriod !== 'undefined' && ppPeriod) return ppPeriod;
    if (window.PeriodUtils) return PeriodUtils.currentWeekPeriod();
    const x = new Date();
    const day = x.getDay();
    x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  function statusBadge(code, label) {
    const colors = {
      SIGNE: { bg: '#ECFDF5', color: '#059669' },
      EN_ATTENTE_SIGNATURE: { bg: '#FFFBEB', color: '#D97706' },
      BROUILLON: { bg: '#EFF6FF', color: '#2563EB' },
      REFUSE: { bg: '#FEF2F2', color: '#DC2626' },
      EXPIRE: { bg: '#F3F4F6', color: '#6B7280' },
      NONE: { bg: '#F9FAFB', color: '#9CA3AF' },
    };
    const c = colors[code] || colors.NONE;
    return '<span style="display:inline-flex;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:'
      + c.bg + ';color:' + c.color + '">' + escapeHtml(label || code) + '</span>';
  }

  function canManageTimesheets() {
    const role = window.Auth?.user?.role || window.currentUser?.role;
    return role === 'RH' || role === 'DRH' || role === 'ADMIN';
  }

  async function loadFeuilleHeureData(force) {
    if (fhLoading && !force) return fhData;
    if (!window.api?.timesheets) return null;

    fhLoading = true;
    try {
      fhData = await api.timesheets(getPeriod());
      renderFeuilleHeureModal();
      updateFeuilleHeureKpi();
      return fhData;
    } catch (err) {
      if (typeof showToast === 'function') {
        showToast(err.error || 'Impossible de charger les feuilles d\'heures');
      }
      return null;
    } finally {
      fhLoading = false;
    }
  }

  function updateFeuilleHeureKpi() {
    const el = document.getElementById('pp-kpi-fh-pending');
    const sub = document.getElementById('pp-kpi-fh-sub');
    if (!el || !fhData?.summary) return;
    el.textContent = String(fhData.summary.pending || 0);
    if (sub) {
      sub.textContent = (fhData.summary.signed || 0) + ' signée(s) · '
        + (fhData.summary.draft || 0) + ' brouillon(s)';
    }
  }

  function renderFeuilleHeureModal() {
    const list = document.getElementById('fh-list');
    const hint = document.getElementById('fh-hint');
    const summaryEl = document.getElementById('fh-summary');
    if (!list) return;

    if (hint) {
      hint.innerHTML = fhData?.signatureConfigured
        ? 'Signatures via <strong>Yousign</strong> (eIDAS — niveau avancé). Le collaborateur reçoit un e-mail avec lien sécurisé.'
        : 'Configurez <code>YOUSIGN_API_KEY</code> dans le backend pour activer les signatures eIDAS.';
    }

    if (summaryEl && fhData?.summary) {
      summaryEl.textContent = (fhData.summary.total || 0) + ' collaborateur(s) · '
        + (fhData.summary.signed || 0) + ' signé(s) · '
        + (fhData.summary.pending || 0) + ' en attente';
    }

    const rows = fhData?.timesheets || [];
    if (!rows.length) {
      list.innerHTML = '<div style="padding:24px;text-align:center;font-size:13px;color:var(--text-3)">Aucune variable pré-paie pour cette période.</div>';
      return;
    }

    list.innerHTML = rows.map(function (t) {
      const checked = fhSelected.has(t.userId) ? ' checked' : '';
      const idArg = t.id ? JSON.stringify(t.id) : 'null';
      let actions = '';
      if (t.id && t.hasFile) {
        actions += '<button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onclick="downloadFeuilleHeure(' + idArg + ')">↓ PDF</button>';
      }
      if (canManageTimesheets()) {
        if (t.statusCode === 'EN_ATTENTE_SIGNATURE' && t.id) {
          actions += ' <button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px;color:#D97706" onclick="remindFeuilleHeure(' + idArg + ')">Relancer</button>';
        } else if (t.id && t.statusCode !== 'SIGNE' && t.hasFile) {
          actions += ' <button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px;color:var(--blue)" onclick="sendFeuilleHeureSignature(' + idArg + ')">Yousign</button>';
        }
      }
      if (t.statusCode === 'EN_ATTENTE_SIGNATURE' && t.signatureLink) {
        actions += ' <a href="' + escapeHtml(t.signatureLink) + '" target="_blank" rel="noopener" class="btn btn-ghost" style="padding:4px 8px;font-size:11px">Lien</a>';
      }
      return '<label style="display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:white">'
        + '<input type="checkbox" class="fh-check" data-user-id="' + escapeHtml(t.userId) + '"' + checked + ' onchange="toggleFhSelect(this)">'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:13px;font-weight:600">' + escapeHtml(t.collabFull || t.collab) + '</div>'
        + '<div style="font-size:11.5px;color:var(--text-3)">' + escapeHtml(t.site) + (t.reference ? ' · ' + escapeHtml(t.reference) : '') + '</div>'
        + '</div>'
        + statusBadge(t.statusCode, t.status)
        + '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-left:8px">' + actions + '</div>'
        + '</label>';
    }).join('');
  }

  window.openFeuilleHeureModal = async function () {
    const modal = document.getElementById('modal-fh-signature');
    if (modal) modal.classList.add('open');
    else if (typeof openModal === 'function') openModal('modal-fh-signature');
    fhSelected = new Set();
    const periodLabel = typeof ppPeriodLabel === 'function' ? ppPeriodLabel(getPeriod()) : getPeriod();
    const titleEl = document.getElementById('fh-modal-period');
    if (titleEl) titleEl.textContent = periodLabel;
    updateFhActionButtons();
    await loadFeuilleHeureData(true);
  };

  window.toggleFhSelect = function (el) {
    const uid = el.dataset.userId;
    if (!uid) return;
    if (el.checked) fhSelected.add(uid);
    else fhSelected.delete(uid);
  };

  window.fhCheckAll = function (val) {
    document.querySelectorAll('.fh-check').forEach(function (c) {
      c.checked = val;
      toggleFhSelect(c);
    });
  };

  window.generateFeuillesHeure = async function () {
    if (!canManageTimesheets()) return;
    const userIds = fhSelected.size ? [...fhSelected] : undefined;
    const btn = document.getElementById('fh-generate-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Génération…'; }
    try {
      const res = await api.generateTimesheets({ period: getPeriod(), userIds });
      if (typeof showToast === 'function') showToast(res.message || 'Feuilles d\'heures générées ✓');
      await loadFeuilleHeureData(true);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur génération');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Générer les PDF'; }
    }
  };

  function updateFhActionButtons() {
    const canManage = canManageTimesheets();
    ['fh-generate-btn', 'fh-send-btn'].forEach(function (id) {
      const btn = document.getElementById(id);
      if (btn) btn.style.display = canManage ? '' : 'none';
    });
  }

  window.sendFeuillesHeureBatch = async function () {
    if (!canManageTimesheets()) return;
    const userIds = fhSelected.size ? [...fhSelected] : undefined;
    const btn = document.getElementById('fh-send-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
    try {
      const res = await api.sendTimesheetSignatures({ period: getPeriod(), userIds });
      if (typeof showToast === 'function') showToast(res.message || 'Signatures lancées ✓');
      await loadFeuilleHeureData(true);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur signature');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Envoyer signatures Yousign'; }
    }
  };

  window.sendFeuilleHeureSignature = async function (id) {
    if (!id) return;
    try {
      const res = await api.startTimesheetSignature(id);
      if (res.signature?.signatureLink && typeof showToast === 'function') {
        showToast('Lien Yousign envoyé au collaborateur ✓');
      } else if (typeof showToast === 'function') {
        showToast('Signature Yousign initiée ✓');
      }
      await loadFeuilleHeureData(true);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur Yousign');
    }
  };

  window.remindFeuilleHeure = async function (id) {
    if (!id) return;
    try {
      const res = await api.remindTimesheetSignature(id);
      if (typeof showToast === 'function') showToast(res.message || 'Rappel envoyé ✓');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur relance');
    }
  };

  window.downloadFeuilleHeure = async function (id) {
    if (!id || !api.downloadTimesheetFile) return;
    try {
      await api.downloadTimesheetFile(id);
      if (typeof showToast === 'function') showToast('Feuille d\'heures téléchargée ✓');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Téléchargement impossible');
    }
  };

  async function loadCollabTimesheetBanner() {
    if (!window.api?.myTimesheet) return;
    const role = window.Auth?.user?.role || window.currentUser?.role;
    if (role !== 'COLLABORATEUR') return;

    const period = getPeriod();
    try {
      const res = await api.myTimesheet(period);
      const t = res.timesheet;
      if (!t) return;

      let banner = document.getElementById('sal-timesheet-banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'sal-timesheet-banner';
        const page = document.getElementById('page-mon-salaire');
        const subtitle = document.getElementById('sal-page-subtitle');
        if (page && subtitle) page.insertBefore(banner, subtitle.nextSibling);
      }

      if (t.statusCode === 'EN_ATTENTE_SIGNATURE' && t.signatureLink) {
        banner.style.cssText = 'background:#EFF6FF;border:1px solid #BFCFFE;border-radius:var(--radius);padding:14px 18px;margin:12px 0 16px;font-size:13px;color:#1E40AF;line-height:1.55';
        banner.innerHTML = '<strong>Feuille d\'heures à signer</strong> — Votre feuille de la semaine est prête. '
          + '<a href="' + escapeHtml(t.signatureLink) + '" target="_blank" rel="noopener" style="color:#2563EB;font-weight:600">Signer via Yousign →</a>';
        banner.style.display = '';
      } else if (t.statusCode === 'SIGNE') {
        banner.style.cssText = 'background:#ECFDF5;border:1px solid #A7F3D0;border-radius:var(--radius);padding:14px 18px;margin:12px 0 16px;font-size:13px;color:#065F46';
        banner.innerHTML = '✓ Feuille d\'heures signée pour cette période'
          + (t.id ? ' · <button type="button" class="btn btn-ghost" style="padding:2px 8px;font-size:11px;margin-left:6px" onclick="downloadFeuilleHeure(' + JSON.stringify(t.id) + ')">Télécharger PDF</button>' : '');
        banner.style.display = '';
      } else {
        banner.style.display = 'none';
      }
    } catch (_e) { /* ignore */ }
  }

  function patchLoadPrepaieData() {
    if (typeof loadPrepaieData !== 'function' || loadPrepaieData.__fhPatched) return;
    const orig = loadPrepaieData;
    window.loadPrepaieData = async function (force) {
      const res = await orig(force);
      if (canManageTimesheets() || (window.Auth?.user?.role === 'MANAGER')) {
        loadFeuilleHeureData(false);
      }
      return res;
    };
    loadPrepaieData.__fhPatched = true;
  }

  function patchShowPage() {
    if (typeof showPage !== 'function' || showPage.__fhPatched) return;
    const orig = showPage;
    window.showPage = function (name, navEl) {
      orig(name, navEl);
      if (name === 'mon-salaire') setTimeout(loadCollabTimesheetBanner, 100);
      if (name === 'prepaie') setTimeout(function () { loadFeuilleHeureData(false); }, 200);
    };
    showPage.__fhPatched = true;
  }

  function patchManagerPrepaieUI() {
    if (typeof applyManagerPrepaieUI !== 'function' || applyManagerPrepaieUI.__fhPatched) return;
    const orig = applyManagerPrepaieUI;
    window.applyManagerPrepaieUI = function () {
      orig();
      const btn = document.getElementById('pp-fh-btn');
      if (btn) btn.style.display = 'none';
    };
    applyManagerPrepaieUI.__fhPatched = true;
  }

  function deferInit() {
    patchLoadPrepaieData();
    patchShowPage();
    patchManagerPrepaieUI();
    if (document.getElementById('page-mon-salaire')?.classList.contains('active')) {
      loadCollabTimesheetBanner();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', deferInit);
  } else {
    deferInit();
  }
})();
