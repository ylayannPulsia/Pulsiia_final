/**
 * Pulsiia — Client API
 * Gère les tokens JWT, le refresh automatique et les appels fetch vers le backend.
 */
(function () {
  'use strict';

  const BASE = '/api';

  // ── Token management ────────────────────────────────────────────────────────

  function getToken() { return localStorage.getItem('pulsiia_token'); }
  function getRefresh() { return localStorage.getItem('pulsiia_refresh'); }
  function getUser() {
    try { return JSON.parse(localStorage.getItem('pulsiia_user') || 'null'); } catch { return null; }
  }

  function clearSession() {
    localStorage.removeItem('pulsiia_token');
    localStorage.removeItem('pulsiia_refresh');
    localStorage.removeItem('pulsiia_user');
  }

  async function refreshToken() {
    const rt = getRefresh();
    if (!rt) return false;
    try {
      const res = await fetch(BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const { accessToken } = await res.json();
      localStorage.setItem('pulsiia_token', accessToken);
      return true;
    } catch { return false; }
  }

  // ── Fetch wrapper ────────────────────────────────────────────────────────────

  async function apiFetch(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res = await fetch(BASE + path, { ...options, headers });

    if (res.status === 401 && getRefresh()) {
      const ok = await refreshToken();
      if (ok) {
        headers['Authorization'] = 'Bearer ' + getToken();
        res = await fetch(BASE + path, { ...options, headers });
      }
    }

    if (res.status === 401) {
      clearSession();
      window.location.href = '/login.html';
      return null;
    }

    return res;
  }

  // ── API methods ──────────────────────────────────────────────────────────────

  const API = {
    auth: {
      async me() { return apiFetch('/auth/me'); },
      async logout() {
        await apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: getRefresh() }) });
        clearSession();
        window.location.href = '/login.html';
      },
      async profile(data) { return apiFetch('/auth/profile', { method: 'PATCH', body: JSON.stringify(data) }); },
      async changePassword(data) { return apiFetch('/auth/password', { method: 'PATCH', body: JSON.stringify(data) }); },
    },
    dashboard: {
      async kpis() { return apiFetch('/dashboard/kpis'); },
      async flux() { return apiFetch('/dashboard/flux'); },
      async alertes() { return apiFetch('/dashboard/alertes'); },
    },
    collaborateurs: {
      async list(params = {}) {
        const q = new URLSearchParams(params).toString();
        return apiFetch('/collaborateurs' + (q ? '?' + q : ''));
      },
      async get(id) { return apiFetch('/collaborateurs/' + id); },
      async create(data) { return apiFetch('/collaborateurs', { method: 'POST', body: JSON.stringify(data) }); },
      async update(id, data) { return apiFetch('/collaborateurs/' + id, { method: 'PATCH', body: JSON.stringify(data) }); },
    },
    absences: {
      async list(params = {}) {
        const q = new URLSearchParams(params).toString();
        return apiFetch('/absences' + (q ? '?' + q : ''));
      },
      async create(data) { return apiFetch('/absences', { method: 'POST', body: JSON.stringify(data) }); },
      async updateStatut(id, statut) { return apiFetch('/absences/' + id + '/statut', { method: 'PATCH', body: JSON.stringify({ statut }) }); },
      async delete(id) { return apiFetch('/absences/' + id, { method: 'DELETE' }); },
    },
    planning: {
      async list(params = {}) {
        const q = new URLSearchParams(params).toString();
        return apiFetch('/planning' + (q ? '?' + q : ''));
      },
      async semaine() { return apiFetch('/planning/semaine'); },
      async create(data) { return apiFetch('/planning', { method: 'POST', body: JSON.stringify(data) }); },
      async update(id, data) { return apiFetch('/planning/' + id, { method: 'PATCH', body: JSON.stringify(data) }); },
      async delete(id) { return apiFetch('/planning/' + id, { method: 'DELETE' }); },
    },
    prepaie: {
      async list(params = {}) {
        const q = new URLSearchParams(params).toString();
        return apiFetch('/prepaie' + (q ? '?' + q : ''));
      },
      async validerTout(periode) { return apiFetch('/prepaie/valider-tout', { method: 'POST', body: JSON.stringify({ periode }) }); },
      async updateStatut(id, statut, anomalie) {
        return apiFetch('/prepaie/' + id + '/statut', { method: 'PATCH', body: JSON.stringify({ statut, anomalie }) });
      },
      exportCSV(periode) { window.location.href = BASE + '/prepaie/export?format=csv&periode=' + (periode || 'mars-2026'); },
    },
    documents: {
      async list(params = {}) {
        const q = new URLSearchParams(params).toString();
        return apiFetch('/documents' + (q ? '?' + q : ''));
      },
      async create(data) { return apiFetch('/documents', { method: 'POST', body: JSON.stringify(data) }); },
      async delete(id) { return apiFetch('/documents/' + id, { method: 'DELETE' }); },
    },
    bienetre: {
      async stats() { return apiFetch('/bienetre/stats'); },
    },
    qcm: {
      async list() { return apiFetch('/qcm'); },
      async get(id) { return apiFetch('/qcm/' + id); },
      async repondre(id, reponses) { return apiFetch('/qcm/' + id + '/repondre', { method: 'POST', body: JSON.stringify({ reponses }) }); },
      async create(data) { return apiFetch('/qcm', { method: 'POST', body: JSON.stringify(data) }); },
    },
    communication: {
      async list() { return apiFetch('/communication'); },
      async create(data) { return apiFetch('/communication', { method: 'POST', body: JSON.stringify(data) }); },
    },
    notifications: {
      async list() { return apiFetch('/notifications'); },
      async markRead(id) { return apiFetch('/notifications/' + id + '/lu', { method: 'PATCH' }); },
      async markAllRead() { return apiFetch('/notifications/tout-lire', { method: 'POST' }); },
    },
    sites: {
      async list() { return apiFetch('/sites'); },
    },
  };

  // ── Expose globally ──────────────────────────────────────────────────────────
  window.PulsiiaAPI = API;
  window.PulsiiaUser = getUser;

  // ── Auth guard ───────────────────────────────────────────────────────────────
  window.addEventListener('DOMContentLoaded', async () => {
    const token = getToken();
    if (!token) {
      window.location.href = '/login.html';
      return;
    }

    // Verify token and load user info into the UI
    const res = await API.auth.me();
    if (!res) return; // redirect already triggered

    if (res.ok) {
      const user = await res.json();
      localStorage.setItem('pulsiia_user', JSON.stringify(user));

      // Inject user info into sidebar
      const nameEl = document.getElementById('sidebar-user-name');
      const roleEl = document.getElementById('sidebar-user-role');
      const avatarEl = document.getElementById('sidebar-avatar');
      if (nameEl) nameEl.textContent = `${user.prenom} ${user.nom}`;
      if (roleEl) roleEl.textContent = `${user.role === 'RH' ? 'DRH' : user.role} · ${user.site?.nom || 'Siège'}`;
      if (avatarEl) avatarEl.textContent = (user.prenom[0] + user.nom[0]).toUpperCase();

      // Wire up logout
      const logoutBtn = document.getElementById('logout-btn');
      if (logoutBtn) logoutBtn.addEventListener('click', () => API.auth.logout());

      // Load notifications count
      loadNotifCount();

      // Load dashboard data if on dashboard page
      loadPageData('dashboard');
    }
  });

  async function loadNotifCount() {
    const res = await API.notifications.list();
    if (!res || !res.ok) return;
    const { unread } = await res.json();
    const badge = document.getElementById('notif-count');
    if (badge) {
      badge.textContent = unread || '';
      badge.style.display = unread ? '' : 'none';
    }
  }

  async function loadPageData(page) {
    if (page === 'dashboard') {
      try {
        const res = await API.dashboard.kpis();
        if (!res || !res.ok) return;
        const kpis = await res.json();
        setKPI('kpi-collabs', kpis.totalCollabs);
        setKPI('kpi-absences', kpis.absencesEnCours);
        setKPI('kpi-decouvert', kpis.shiftsDecouverts);
        setKPI('kpi-prepaie', kpis.variablesAValider);
      } catch (e) { /* keep static data */ }
    }
  }

  function setKPI(id, value) {
    const el = document.getElementById(id);
    if (el && value !== undefined) el.textContent = value;
  }

  // Expose loadPageData for the showPage hook
  window._pulsiiaLoadPage = loadPageData;

  // Wire up real logout to sidebar
  function wireLogout() {
    const card = document.getElementById('sidebar-user-card');
    if (card) {
      card.title = 'Cliquer pour se déconnecter';
      card.addEventListener('click', () => {
        if (confirm('Se déconnecter ?')) API.auth.logout();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', wireLogout);

})();
