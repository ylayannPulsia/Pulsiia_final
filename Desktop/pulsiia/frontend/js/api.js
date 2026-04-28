/**
 * Pulsiia — Client API
 * Gère les tokens JWT et les appels fetch.
 * N'overrides RIEN sur l'UI — uniquement du réseau.
 */
(function () {
  'use strict';

  const BASE = '/api';

  function getToken()   { return localStorage.getItem('pulsiia_token'); }
  function getRefresh() { return localStorage.getItem('pulsiia_refresh'); }
  function getUser()    {
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

  async function apiFetch(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(BASE + path, { ...options, headers });
    } catch (err) {
      // Réseau down — on ne redirige pas, on retourne null silencieusement
      console.warn('[Pulsiia API] réseau indisponible:', path);
      return null;
    }

    if (res.status === 401 && getRefresh()) {
      const ok = await refreshToken();
      if (ok) {
        headers['Authorization'] = 'Bearer ' + getToken();
        try { res = await fetch(BASE + path, { ...options, headers }); }
        catch { return null; }
      }
    }

    if (res.status === 401) {
      // Token vraiment invalide → redirect login seulement si on a tenté une vraie action
      clearSession();
      window.location.href = '/';
      return null;
    }

    return res;
  }

  const API = {
    auth: {
      async me()       { return apiFetch('/auth/me'); },
      async profile(d) { return apiFetch('/auth/profile',  { method: 'PATCH', body: JSON.stringify(d) }); },
      async password(d){ return apiFetch('/auth/password', { method: 'PATCH', body: JSON.stringify(d) }); },
      async logout()   {
        try { await apiFetch('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken: getRefresh() }) }); }
        catch {}
        clearSession();
        window.location.href = '/login.html';
      },
    },
    dashboard: {
      async kpis()    { return apiFetch('/dashboard/kpis'); },
      async flux()    { return apiFetch('/dashboard/flux'); },
      async alertes() { return apiFetch('/dashboard/alertes'); },
    },
    absences: {
      async list(p={})  { return apiFetch('/absences' + (Object.keys(p).length ? '?' + new URLSearchParams(p) : '')); },
      async create(d)   { return apiFetch('/absences', { method: 'POST', body: JSON.stringify(d) }); },
      async updateStatut(id, statut) { return apiFetch('/absences/' + id + '/statut', { method: 'PATCH', body: JSON.stringify({ statut }) }); },
      async del(id)     { return apiFetch('/absences/' + id, { method: 'DELETE' }); },
    },
    planning: {
      async list(p={}) { return apiFetch('/planning' + (Object.keys(p).length ? '?' + new URLSearchParams(p) : '')); },
      async semaine()  { return apiFetch('/planning/semaine'); },
      async create(d)  { return apiFetch('/planning', { method: 'POST', body: JSON.stringify(d) }); },
      async update(id,d){ return apiFetch('/planning/' + id, { method: 'PATCH', body: JSON.stringify(d) }); },
    },
    prepaie: {
      async list(p={}) { return apiFetch('/prepaie' + (Object.keys(p).length ? '?' + new URLSearchParams(p) : '')); },
      async create(d)  { return apiFetch('/prepaie', { method: 'POST', body: JSON.stringify(d) }); },
      async updateStatut(id, statut, anomalie) {
        return apiFetch('/prepaie/' + id + '/statut', { method: 'PATCH', body: JSON.stringify({ statut, anomalie }) });
      },
      async validerTout(periode) { return apiFetch('/prepaie/valider-tout', { method: 'POST', body: JSON.stringify({ periode }) }); },
      exportCSV(periode) { window.location.href = BASE + '/prepaie/export?format=csv&periode=' + (periode || 'mars-2026'); },
    },
    documents: {
      async list(p={}) { return apiFetch('/documents' + (Object.keys(p).length ? '?' + new URLSearchParams(p) : '')); },
      async create(d)  { return apiFetch('/documents', { method: 'POST', body: JSON.stringify(d) }); },
      async del(id)    { return apiFetch('/documents/' + id, { method: 'DELETE' }); },
    },
    qcm: {
      async list()         { return apiFetch('/qcm'); },
      async get(id)        { return apiFetch('/qcm/' + id); },
      async repondre(id,r) { return apiFetch('/qcm/' + id + '/repondre', { method: 'POST', body: JSON.stringify({ reponses: r }) }); },
    },
    communication: {
      async list()   { return apiFetch('/communication'); },
      async create(d){ return apiFetch('/communication', { method: 'POST', body: JSON.stringify(d) }); },
    },
    notifications: {
      async list()     { return apiFetch('/notifications'); },
      async markRead(id){ return apiFetch('/notifications/' + id + '/lu', { method: 'PATCH' }); },
      async markAllRead(){ return apiFetch('/notifications/tout-lire', { method: 'POST' }); },
    },
    bienetre: {
      async stats() { return apiFetch('/bienetre/stats'); },
    },
    collaborateurs: {
      async list(p={}) { return apiFetch('/collaborateurs' + (Object.keys(p).length ? '?' + new URLSearchParams(p) : '')); },
    },
    sites: {
      async list() { return apiFetch('/sites'); },
    },
  };

  window.PulsiiaAPI  = API;
  window.PulsiiaUser = getUser;
  window.PulsiiaLogout = () => API.auth.logout();

})();
