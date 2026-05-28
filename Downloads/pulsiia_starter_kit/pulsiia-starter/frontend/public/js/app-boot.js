// Navigation core — disponible immédiatement (avant le gros script maquette)
(function () {
  'use strict';

  var PAGE_TITLES = {
    dashboard: 'Tableau de bord',
    'dashboard-rh': 'Dashboard RH',
    planning: 'Planning',
    'planning-ai': 'Planning IA — Préparation',
    'planning-ai-studio': 'Planning IA — Atelier',
    prepaie: 'Pré-paie',
    bienetre: 'Bien-être',
    qcm: 'QCM Journalier',
    collaborateurs: 'Collaborateurs',
    rapports: 'Rapports ROI',
    historique: 'Historique des actions',
    absences: 'Absences & Congés',
    settings: 'Paramètres',
    documents: 'Documents RH',
    communication: 'Communication',
    flux: 'Flux & Actions',
    'mon-planning': 'Mon planning',
    'mon-salaire': 'Mon salaire',
    'mes-docs': 'Mes documents',
    'mes-params': 'Mon profil',
    'accueil-collab': 'Accueil',
    organigramme: 'Organigramme',
    billing: 'Facturation',
  };

  function markAppReady() {
    document.body.classList.add('app-ready');
    var loader = document.getElementById('app-bootstrap-loader');
    if (loader) {
      loader.setAttribute('aria-busy', 'false');
      loader.style.display = 'none';
      loader.style.pointerEvents = 'none';
    }
  }

  function showPageCore(name, navEl) {
    document.querySelectorAll('.page').forEach(function (p) {
      p.classList.remove('active');
    });
    document.querySelectorAll('.nav-item').forEach(function (n) {
      n.classList.remove('active');
    });
    var pg = document.getElementById('page-' + name);
    if (pg) pg.classList.add('active');
    if (navEl) navEl.classList.add('active');
    var pageTitleEl = document.getElementById('page-title');
    if (pageTitleEl) pageTitleEl.textContent = PAGE_TITLES[name] || name;
    if (typeof window.updateTopbarForRole === 'function') window.updateTopbarForRole();
  }

  function getNavItemForPage(name) {
    return document.querySelector('.nav-item[onclick*="' + name + '"]');
  }

  function getActivePageName() {
    var activePage = document.querySelector('.page.active');
    if (!activePage || !activePage.id || activePage.id.indexOf('page-') !== 0) return null;
    return activePage.id.slice(5);
  }

  window.__pageNavQueue = [];
  window.__showPageExtras = null;

  function showPage(name, navEl, options) {
    options = options || {};
    showPageCore(name, navEl);
    if (!options.fromHistory && window.history && typeof window.history.pushState === 'function') {
      var statePage = window.history.state && window.history.state.page;
      var state = { page: name };
      if (statePage !== name) {
        window.history.pushState(state, '', window.location.pathname + window.location.search);
      } else if (options.replaceHistory && typeof window.history.replaceState === 'function') {
        window.history.replaceState(state, '', window.location.pathname + window.location.search);
      }
    }
    if (typeof window.__showPageExtras === 'function') {
      try {
        window.__showPageExtras(name, navEl);
      } catch (err) {
        console.warn('[showPage extras]', err);
      }
    }
  }

  window.markAppReady = markAppReady;
  window.showPageCore = showPageCore;
  window.showPage = showPage;
  window.__showPageReal = showPage;
  window.PAGE_TITLES = PAGE_TITLES;

  window.__pageNavQueue.forEach(function (args) {
    showPage.apply(null, args);
  });
  window.__pageNavQueue = [];

  function restoreInitialPage() {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    var initialPage = (window.history.state && window.history.state.page) || getActivePageName() || 'dashboard';
    window.history.replaceState({ page: initialPage }, '', window.location.pathname + window.location.search);
    var navEl = getNavItemForPage(initialPage);
    if (initialPage !== getActivePageName()) {
      showPage(initialPage, navEl, { fromHistory: true });
    } else if (typeof window.__showPageExtras === 'function') {
      window.__showPageExtras(initialPage, navEl);
    }
  }

  function whenShowPageExtrasReady(cb, attempts) {
    attempts = attempts || 0;
    if (typeof window.__showPageExtras === 'function') {
      cb();
      return;
    }
    if (attempts > 240) return;
    setTimeout(function () { whenShowPageExtrasReady(cb, attempts + 1); }, 25);
  }

  whenShowPageExtrasReady(restoreInitialPage);

  window.addEventListener('popstate', function (event) {
    var page = event.state && event.state.page;
    if (!page) return;
    showPage(page, getNavItemForPage(page), { fromHistory: true });
  });

  markAppReady();
})();
