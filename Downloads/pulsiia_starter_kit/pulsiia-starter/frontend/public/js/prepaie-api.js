// prepaie-api.js — Pré-paie allégée pour managers (équipe + site uniquement)
(function () {
  'use strict';

  function isManagerPrepaieScoped() {
    const role = window.Auth?.user?.role || window.currentUser?.role;
    return role === 'MANAGER' || window._planManagerScoped === true;
  }

  function getManagerSiteName() {
    if (window._managerPlanSiteName) return window._managerPlanSiteName;
    const u = window.Auth?.user || window.currentUser;
    return u?.site?.name || null;
  }

  function lockManagerSiteFilter() {
    if (!isManagerPrepaieScoped()) return;
    const siteName = getManagerSiteName();
    const filterSel = document.getElementById('pp-site-filter');
    if (!filterSel || !siteName) return;
    const esc = siteName.replace(/"/g, '&quot;').replace(/</g, '&lt;');
    filterSel.innerHTML = '<option value="' + esc + '">' + esc + '</option>';
    filterSel.value = siteName;
    filterSel.disabled = true;
    filterSel.title = 'Votre établissement — équipe gérée uniquement';
  }

  function applyManagerPrepaieUI() {
    if (!isManagerPrepaieScoped()) return;

    const h2 = document.querySelector('#page-prepaie h2');
    if (h2) h2.textContent = 'Pré-paie — Mon équipe';

    ['pp-lock-btn', 'pp-add-btn', 'pp-validate-all-btn'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });

    document.querySelectorAll('#page-prepaie button[onclick*="syncPrepaieFromPlanning"],'
      + '#page-prepaie button[onclick*="openSilaeExport"],'
      + '#page-prepaie button[onclick*="openRecapModal"],'
      + '#page-prepaie button[onclick*="openFeuilleHeureModal"]').forEach(function (el) {
      el.style.display = 'none';
    });

    const fhKpi = document.getElementById('pp-kpi-fh-pending');
    if (fhKpi) {
      const card = fhKpi.closest('.summary-card');
      if (card) card.style.display = 'none';
    }

    const hsKpi = document.getElementById('pp-kpi-hs-euros');
    if (hsKpi) {
      const card = hsKpi.closest('.summary-card');
      if (card) card.style.display = 'none';
    }

    lockManagerSiteFilter();

    let banner = document.getElementById('pp-manager-scope-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'pp-manager-scope-banner';
      banner.style.cssText = 'background:#EFF6FF;border:1px solid #BFCFFE;border-radius:var(--radius);padding:12px 16px;margin-bottom:16px;font-size:13px;color:#1E40AF;line-height:1.5';
      banner.textContent = 'Vue limitée à votre équipe : contrôle des heures et validation des variables. Export paie, clôture et ajouts manuels sont réservés aux RH.';
      const page = document.getElementById('page-prepaie');
      const momAlert = document.getElementById('pp-mom-alert');
      if (page && momAlert) page.insertBefore(banner, momAlert);
    }
    banner.style.display = '';
  }

  function patchLoadPPUsers() {
    if (typeof loadPPUsers !== 'function' || loadPPUsers.__ppScopePatched) return;
    const orig = loadPPUsers;
    window.loadPPUsers = async function () {
      await orig();
      lockManagerSiteFilter();
    };
    loadPPUsers.__ppScopePatched = true;
  }

  function patchLoadPrepaieData() {
    if (typeof loadPrepaieData !== 'function' || loadPrepaieData.__ppScopePatched) return;
    const orig = loadPrepaieData;
    window.loadPrepaieData = async function (force) {
      lockManagerSiteFilter();
      await orig(force);
      applyManagerPrepaieUI();
    };
    loadPrepaieData.__ppScopePatched = true;
  }

  function patchRenderPrepaie() {
    if (typeof renderPrepaie !== 'function' || renderPrepaie.__ppScopePatched) return;
    const orig = renderPrepaie;
    window.renderPrepaie = function () {
      orig();
      if (isManagerPrepaieScoped()) {
        const hsKpi = document.getElementById('pp-kpi-hs-euros');
        if (hsKpi) {
          const card = hsKpi.closest('.summary-card');
          if (card) card.style.display = 'none';
        }
      }
    };
    renderPrepaie.__ppScopePatched = true;
  }

  function patchOpenPPDetail() {
    if (typeof openPPDetail !== 'function' || openPPDetail.__ppScopePatched) return;
    const orig = openPPDetail;
    window.openPPDetail = function (id) {
      orig(id);
      if (!isManagerPrepaieScoped()) return;
      const footer = document.getElementById('pp-detail-footer');
      if (!footer) return;
      footer.querySelectorAll('button').forEach(function (btn) {
        const onclick = btn.getAttribute('onclick') || '';
        if (onclick.indexOf('downloadRecap') >= 0) btn.style.display = 'none';
      });
    };
    openPPDetail.__ppScopePatched = true;
  }

  function chainApplyAuthenticatedSession() {
    if (typeof applyAuthenticatedSession !== 'function' || applyAuthenticatedSession.__ppScopeChained) return;
    const orig = applyAuthenticatedSession;
    window.applyAuthenticatedSession = function (user) {
      orig(user);
      if (user && user.role === 'MANAGER') applyManagerPrepaieUI();
    };
    applyAuthenticatedSession.__ppScopeChained = true;
  }

  function chainShowPage() {
    if (typeof showPage !== 'function' || showPage.__ppScopeChained) return;
    const orig = showPage;
    window.showPage = function (name, navEl) {
      orig(name, navEl);
      if (name === 'prepaie') setTimeout(applyManagerPrepaieUI, 0);
    };
    showPage.__ppScopeChained = true;
  }

  function deferInit() {
    if (typeof loadPrepaieData !== 'function') {
      setTimeout(deferInit, 40);
      return;
    }
    patchLoadPPUsers();
    patchLoadPrepaieData();
    patchRenderPrepaie();
    patchOpenPPDetail();
    chainApplyAuthenticatedSession();
    chainShowPage();
    if (isManagerPrepaieScoped()) applyManagerPrepaieUI();
  }

  window.applyManagerPrepaieUI = applyManagerPrepaieUI;
  window.isManagerPrepaieScoped = isManagerPrepaieScoped;

  deferInit();
})();
