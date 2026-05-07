/* Pulsiia — client HTTP avec gestion automatique des tokens JWT */
'use strict';

(function () {
  const BASE = '/api';
  let _at = null; // access token (mémoire uniquement)

  // ─── Stockage tokens ────────────────────────────────────────────────────────

  function saveRefresh(rt) { if (rt) localStorage.setItem('pls_rt', rt); }
  function getRefresh() { return localStorage.getItem('pls_rt'); }
  function clearTokens() { _at = null; localStorage.removeItem('pls_rt'); }

  async function _refresh() {
    const rt = getRefresh();
    if (!rt) throw new Error('no_rt');
    const r = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!r.ok) { clearTokens(); throw new Error('refresh_failed'); }
    const d = await r.json();
    _at = d.accessToken;
    saveRefresh(d.refreshToken);
    return _at;
  }

  // ─── Requête authentifiée ────────────────────────────────────────────────────

  async function req(method, path, body, opts = {}) {
    if (!_at) { try { await _refresh(); } catch { redirect(); return; } }

    const doFetch = (token) => fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(opts.headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    let r = await doFetch(_at);

    // Token expiré → refresh puis retry
    if (r.status === 401) {
      try { _at = await _refresh(); r = await doFetch(_at); }
      catch { redirect(); return; }
    }

    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw Object.assign(new Error(err.error || 'api_error'), { status: r.status, code: err.code });
    }

    const ct = r.headers.get('content-type') || '';
    if (ct.includes('text/csv')) return r.blob();
    if (r.status === 204) return null;
    return r.json();
  }

  function redirect() { window.location.href = '/login.html'; }

  // ─── Auth ────────────────────────────────────────────────────────────────────

  async function login(email, password) {
    const r = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!r.ok) { const e = await r.json(); throw Object.assign(new Error(e.error), { code: e.code }); }
    const d = await r.json();
    _at = d.accessToken;
    saveRefresh(d.refreshToken);
    return d;
  }

  async function logout() {
    const rt = getRefresh();
    if (rt) await fetch(`${BASE}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) }).catch(() => {});
    clearTokens();
  }

  async function initAuth() {
    if (_at) return true;
    if (!getRefresh()) return false;
    try { await _refresh(); return true; } catch { return false; }
  }

  // ─── API métier ──────────────────────────────────────────────────────────────

  const API = {
    login,
    logout,
    initAuth,
    clearTokens,

    // Auth
    me: () => req('GET', '/auth/me'),

    // Dashboard
    kpis: () => req('GET', '/dashboard/kpis'),
    activity: (limit = 15) => req('GET', `/dashboard/activity?limit=${limit}`),

    // Planning
    planningWeek: (weekStart) => req('GET', `/planning/week${weekStart ? '?weekStart=' + weekStart : ''}`),
    createShift: (data) => req('POST', '/planning/shifts', data),
    updateShift: (id, data) => req('PATCH', `/planning/shifts/${id}`, data),
    deleteShift: (id) => req('DELETE', `/planning/shifts/${id}`),
    publishWeek: (weekStart) => req('POST', '/planning/shifts/publish', { weekStart }),
    planningAlerts: () => req('GET', '/planning/alerts'),

    // Absences
    absences: (p = {}) => req('GET', '/absences?' + new URLSearchParams(p)),
    absenceStats: () => req('GET', '/absences/stats/summary'),
    createAbsence: (d) => req('POST', '/absences', d),
    absenceStatus: (id, status, rejectReason) => req('PUT', `/absences/${id}/status`, { status, rejectReason }),
    deleteAbsence: (id) => req('DELETE', `/absences/${id}`),

    // Pré-paie
    payVars: (p = {}) => req('GET', '/prepaie/variables?' + new URLSearchParams(p)),
    payVarSummary: () => req('GET', '/prepaie/variables/summary'),
    validateVar: (id) => req('PUT', `/prepaie/variables/${id}/validate`),
    rejectVar: (id, reason) => req('PUT', `/prepaie/variables/${id}/reject`, { reason }),
    validateAll: (year, month) => req('POST', '/prepaie/variables/validate-all', { year, month }),
    exportPay: (year, month) => req('GET', `/prepaie/export?year=${year}&month=${month}`),

    // Bien-être
    surveys: () => req('GET', '/bienetre/surveys'),
    surveyScores: (id) => req('GET', `/bienetre/surveys/${id}/scores`),
    trends: (weeks = 8) => req('GET', `/bienetre/trends?weeks=${weeks}`),
    createSurvey: (d) => req('POST', '/bienetre/surveys', d),
    respondSurvey: (id, answers) => req('POST', `/bienetre/surveys/${id}/respond`, { answers }),
    closeSurvey: (id) => req('POST', `/bienetre/surveys/${id}/close`),

    // Communication
    channels: () => req('GET', '/communication/channels'),
    messages: (channelId, before) => req('GET', `/communication/channels/${channelId}/messages${before ? '?before=' + before : ''}`),
    sendMessage: (channelId, content, parentId) => req('POST', `/communication/channels/${channelId}/messages`, { content, parentId }),
    editMessage: (id, content) => req('PATCH', `/communication/messages/${id}`, { content }),
    deleteMessage: (id) => req('DELETE', `/communication/messages/${id}`),
    pinMessage: (id) => req('POST', `/communication/messages/${id}/pin`),
    createChannel: (d) => req('POST', '/communication/channels', d),

    // Users & Sites
    users: (p = {}) => req('GET', '/users?' + new URLSearchParams(p)),
    user: (id) => req('GET', `/users/${id}`),
    sites: () => req('GET', '/sites'),
    site: (id) => req('GET', `/sites/${id}`),
  };

  window.API = API;
})();
