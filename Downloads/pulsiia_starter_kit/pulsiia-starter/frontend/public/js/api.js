// frontend/public/js/api.js
// Client API centralisé avec gestion automatique des tokens

(function() {
  const API_BASE = window.__PULSIIA_CONFIG__?.apiUrl || 'http://localhost:3001';

  const Auth = {
    get accessToken()  { return sessionStorage.getItem('access_token'); },
    set accessToken(v) { sessionStorage.setItem('access_token', v); },

    get refreshToken()  { return localStorage.getItem('refresh_token'); },
    set refreshToken(v) { localStorage.setItem('refresh_token', v); },

    get user()  { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; }},
    set user(v) { localStorage.setItem('user', JSON.stringify(v)); },

    isAuthenticated() { return !!this.accessToken; },

    clear() {
      sessionStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
    },
  };

  let refreshing = null;

  async function refreshAccessToken() {
    if (refreshing) return refreshing;

    refreshing = fetch(`${API_BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: Auth.refreshToken }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error('Refresh failed');
        const data = await res.json();
        Auth.accessToken = data.accessToken;
        Auth.refreshToken = data.refreshToken;
        return data.accessToken;
      })
      .catch((err) => {
        Auth.clear();
        window.location.href = '/';
        throw err;
      })
      .finally(() => { refreshing = null; });

    return refreshing;
  }

  const REQUEST_TIMEOUT_MS = 15000;

  function fetchWithTimeout(url, options = {}, ms = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  async function request(method, path, body = null, retry = true, timeoutMs = REQUEST_TIMEOUT_MS) {
    const headers = { 'Content-Type': 'application/json' };
    if (Auth.accessToken) headers['Authorization'] = `Bearer ${Auth.accessToken}`;

    const options = { method, headers };
    if (body != null) options.body = JSON.stringify(body);

    let response;
    try {
      response = await fetchWithTimeout(`${API_BASE}${path}`, options, timeoutMs);
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw {
          status: 0,
          message: timeoutMs > REQUEST_TIMEOUT_MS
            ? 'Délai dépassé — l\'envoi des invitations prend plus de temps que prévu.'
            : 'Délai dépassé — vérifiez que le backend tourne (port 3001).',
        };
      }
      throw { status: 0, message: 'Erreur réseau', offline: !navigator.onLine };
    }

    // Token expired → refresh and retry once
    if (response.status === 401 && retry && Auth.refreshToken) {
      const errBody = await response.clone().json().catch(() => ({}));
      if (errBody.code === 'TOKEN_EXPIRED') {
        try {
          await refreshAccessToken();
          return request(method, path, body, false, timeoutMs);
        } catch {
          throw { status: 401, message: 'Session expirée' };
        }
      }
    }

    const contentType = response.headers.get('Content-Type') || '';
    const isJson = contentType.includes('application/json') || contentType.includes('+json');

    if (!response.ok) {
      const data = isJson ? await response.json().catch(() => ({})) : {};
      throw { status: response.status, ...data };
    }

    if (!isJson) {
      return response;
    }
    return response.json();
  }

  function buildQuery(params) {
    const qs = new URLSearchParams();
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value != null && value !== '') qs.set(key, value);
    });
    const str = qs.toString();
    return str ? `?${str}` : '';
  }

  function parseFilenameFromDisposition(header) {
    if (!header) return null;
    const utf8 = header.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8) return decodeURIComponent(utf8[1]);
    const plain = header.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1] : null;
  }

  const api = {
    // ── Auth ───────────────────────────────────────────────────
    async login(email, password) {
      let response;
      try {
        response = await fetch(`${API_BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      } catch {
        throw {
          status: 0,
          message: 'Impossible de joindre l’API. Vérifiez que le backend tourne sur ' + API_BASE,
        };
      }

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg = data.error
          || (Array.isArray(data.errors) && data.errors[0]?.msg)
          || 'Connexion refusée';
        throw { status: response.status, error: msg, ...data };
      }

      if (data.requires2FA) {
        throw {
          requires2FA: true,
          challengeToken: data.challengeToken,
          message: data.message || 'Code d\'authentification requis.',
        };
      }

      if (data.requiresCompanySelection) {
        throw {
          requiresCompanySelection: true,
          selectionToken: data.selectionToken,
          companies: data.companies || [],
          message: data.message || 'Choisissez votre entreprise.',
        };
      }

      Auth.accessToken  = data.accessToken;
      Auth.refreshToken = data.refreshToken;
      Auth.user         = data.user;
      return data.user;
    },
    async selectCompany(selectionToken, userId) {
      const response = await fetch(`${API_BASE}/api/auth/select-company`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectionToken, userId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw { status: response.status, error: data.error || 'Sélection refusée', ...data };
      }
      if (data.requires2FA) {
        throw {
          requires2FA: true,
          challengeToken: data.challengeToken,
          message: data.message,
        };
      }
      Auth.accessToken = data.accessToken;
      Auth.refreshToken = data.refreshToken;
      Auth.user = data.user;
      return data.user;
    },
    async logout() {
      await request('POST', '/api/auth/logout', { refreshToken: Auth.refreshToken })
        .catch(() => {});
      Auth.clear();
    },
    async me() { return request('GET', '/api/auth/me'); },
    async changePassword(currentPassword, newPassword) {
      return request('POST', '/api/auth/change-password', { currentPassword, newPassword });
    },
    async checkDomain(email) { return request('POST', '/api/auth/check-domain', { email }); },

    // ── Dashboard ──────────────────────────────────────────────
    async dashboardKpis()     { return request('GET', '/api/dashboard/kpis'); },
    async dashboardActivity() { return request('GET', '/api/dashboard/activity'); },

    // ── Rapports ROI ───────────────────────────────────────────
    async reportsRoi(params = {}) {
      return request('GET', `/api/reports/roi${buildQuery(params)}`);
    },
    async reportsRoiExport(type, period, options = {}) {
      const format = options.format || 'csv';
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;

      const query = { type, period, format };
      let response = await fetch(
        `${API_BASE}/api/reports/roi/export${buildQuery(query)}`,
        { headers },
      );

      if (response.status === 401 && Auth.refreshToken) {
        const errBody = await response.clone().json().catch(() => ({}));
        if (errBody.code === 'TOKEN_EXPIRED') {
          await refreshAccessToken();
          headers.Authorization = `Bearer ${Auth.accessToken}`;
          response = await fetch(
            `${API_BASE}/api/reports/roi/export${buildQuery(query)}`,
            { headers },
          );
        }
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw { status: response.status, ...data };
      }

      const blob = await response.blob();
      const filename =
        parseFilenameFromDisposition(response.headers.get('Content-Disposition')) ||
        `pulsiia-rapport-${type}.csv`;

      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      return { filename, blobUrl };
    },

    // ── Planning ───────────────────────────────────────────────
    async planningWeek(from, siteId) {
      return request('GET', `/api/planning/week${buildQuery({ from, siteId })}`);
    },
    async planningWeekAll(from) {
      return request('GET', `/api/planning/week-all${buildQuery({ from })}`);
    },
    async planningAlerts() { return request('GET', '/api/planning/alerts'); },
    async createShift(data)   { return request('POST', '/api/planning/shifts', data); },
    async updateShift(id, data) { return request('PUT', `/api/planning/shifts/${id}`, data); },
    async deleteShift(id)     { return request('DELETE', `/api/planning/shifts/${id}`); },
    async publishPlanningWeek(data) { return request('POST', '/api/planning/publish-week', data); },

    // ── Planning IA générative (Claude) ────────────────────────
    async planningAiStatus() { return request('GET', '/api/planning/ai/status'); },
    async planningAiSites()  { return request('GET', '/api/planning/ai/sites'); },
    async planningAiWeek(siteId, from) {
      return request('GET', `/api/planning/ai/week${buildQuery({ siteId, from })}`);
    },
    async planningAiGenerate(siteId, weekStart, options = {}) {
      const body = { siteId, weekStart, ...options };
      if (body.naturalInput == null || body.naturalInput === '') delete body.naturalInput;
      if (body.structuredParams == null) delete body.structuredParams;
      return request('POST', '/api/planning/ai/generate', body);
    },
    async planningAiOptimize(siteId, weekStart, issue) {
      return request('POST', '/api/planning/ai/optimize', { siteId, weekStart, issue });
    },
    async planningAiValidate(planningWeekId) {
      return request('POST', `/api/planning/ai/${encodeURIComponent(planningWeekId)}/validate`);
    },
    async planningAiPublish(planningWeekId) {
      return request('POST', `/api/planning/ai/${encodeURIComponent(planningWeekId)}/publish`);
    },
    async planningAiDelete(planningWeekId) {
      return request('DELETE', `/api/planning/ai/${encodeURIComponent(planningWeekId)}`);
    },
    async planningAiAlerts(siteId, date) {
      return request('GET', `/api/planning/ai/alerts${buildQuery({ siteId, date })}`);
    },
    async planningAiChat(siteId, weekStart, message, planningWeekId, options = {}) {
      const body = { siteId, weekStart, message, planningWeekId, ...options };
      if (!body.planningWeekId) delete body.planningWeekId;
      return request('POST', '/api/planning/ai/chat', body);
    },

    // ── Pré-paie ───────────────────────────────────────────────
    // Exemple : const data = await api.prepaieSummary('2026-05');
    async prepaieVariables(periodOrFilters, filters = {}) {
      let period;
      let rest;
      if (periodOrFilters != null && typeof periodOrFilters === 'object') {
        ({ period, ...rest } = periodOrFilters);
      } else {
        period = periodOrFilters;
        rest = filters;
      }
      return request('GET', `/api/prepaie/variables${buildQuery({ period, ...rest })}`);
    },
    async prepaieSummary(periodOrFilters) {
      const period = periodOrFilters != null && typeof periodOrFilters === 'object'
        ? periodOrFilters.period
        : periodOrFilters;
      return request('GET', `/api/prepaie/summary${buildQuery({ period })}`);
    },
    async createPayVariable(data) {
      return request('POST', '/api/prepaie/variables', data);
    },
    async updatePayVariable(id, data) {
      return request('PUT', `/api/prepaie/variables/${id}`, data);
    },
    async syncPrepaie(period) {
      return request('POST', '/api/prepaie/sync', period ? { period } : {});
    },
    async lockPrepaiePeriod(period) {
      return request('POST', '/api/prepaie/period/lock', period ? { period } : {});
    },
    async unlockPrepaiePeriod(period) {
      return request('POST', '/api/prepaie/period/unlock', period ? { period } : {});
    },
    async validateVariable(id) {
      return request('PUT', `/api/prepaie/variables/${id}/validate`);
    },
    async unvalidateVariable(id) {
      return request('PUT', `/api/prepaie/variables/${id}/unvalidate`);
    },
    async rejectVariable(id, reason) {
      return request('PUT', `/api/prepaie/variables/${id}/reject`, { reason });
    },
    async deleteVariable(id) {
      return request('DELETE', `/api/prepaie/variables/${id}`);
    },
    async validateAllVariables(period) {
      return request('POST', '/api/prepaie/validate-all', period ? { period } : {});
    },

    /** URL brute (sans jeton) — préférer downloadPrepaieExport pour le téléchargement. */
    prepaieExportUrl(format, period, filters = {}) {
      return `${API_BASE}/api/prepaie/export${buildQuery({ format, period, ...filters })}`;
    },

    /**
     * Télécharge un export Silae / Sage / ADP / CSV (Bearer inclus).
     * @example await api.downloadPrepaieExport('silae', '2026-05');
     */
    async downloadPrepaieExport(format, period, filters = {}) {
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;

      let response = await fetch(
        `${API_BASE}/api/prepaie/export${buildQuery({ format, period, ...filters })}`,
        { headers },
      );

      if (response.status === 401 && Auth.refreshToken) {
        const errBody = await response.clone().json().catch(() => ({}));
        if (errBody.code === 'TOKEN_EXPIRED') {
          await refreshAccessToken();
          headers.Authorization = `Bearer ${Auth.accessToken}`;
          response = await fetch(
            `${API_BASE}/api/prepaie/export${buildQuery({ format, period, ...filters })}`,
            { headers },
          );
        }
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw { status: response.status, ...data };
      }

      const blob = await response.blob();
      const filename =
        parseFilenameFromDisposition(response.headers.get('Content-Disposition')) ||
        `prepaie_${period || 'export'}.${format === 'adp' ? 'xml' : format === 'sage' ? 'txt' : 'csv'}`;

      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      return { filename, blobUrl };
    },

    /** Alias de downloadPrepaieExport (export authentifié). */
    prepaieExport(format, period, filters) {
      return this.downloadPrepaieExport(format, period, filters);
    },

    // ── Audit / Historique ─────────────────────────────────────
    async auditLogs(filters = {}) {
      return request('GET', `/api/audit${buildQuery(filters)}`);
    },

    // ── Absences ───────────────────────────────────────────────
    // Exemple : const { absences } = await api.absences({ status: 'EN_ATTENTE' });
    async absences(filters = {}) {
      const params = filters != null && typeof filters === 'object' ? filters : {};
      return request('GET', `/api/absences${buildQuery(params)}`);
    },
    async absencesStats(period) {
      return request('GET', `/api/absences/stats/summary${buildQuery({ period })}`);
    },
    async absencesCalendar(month, siteId) {
      return request('GET', `/api/absences/calendar${buildQuery({ month, siteId })}`);
    },
    async absencesBalance(userId, year) {
      return request('GET', `/api/absences/balance${buildQuery({ userId, year })}`);
    },
    async createAbsence(data) {
      return request('POST', '/api/absences', data);
    },
    async updateAbsenceStatus(id, status, refuseReason) {
      return request('PUT', `/api/absences/${id}/status`, { status, refuseReason });
    },
    async cancelAbsence(id) {
      return request('DELETE', `/api/absences/${id}`);
    },

    // ── Bien-être ──────────────────────────────────────────────
    // Exemple : const { survey, alreadyAnswered } = await api.currentSurvey();
    async currentSurvey() {
      const data = await request('GET', '/api/bienetre/surveys/current');
      return {
        survey: data.survey,
        alreadyAnswered: Boolean(data.hasResponded),
        hasResponded: Boolean(data.hasResponded),
        todayScore: data.todayScore ?? null,
        respondedAt: data.respondedAt ?? null,
        availability: data.availability || null,
      };
    },
    async respondSurvey(id, answers) {
      return request('POST', `/api/bienetre/surveys/${id}/respond`, { answers });
    },
    async wellbeingScores(siteId) {
      return request('GET', `/api/bienetre/scores${buildQuery(siteId ? { siteId } : {})}`);
    },
    async wellbeingTrends(weeks = 8, siteId) {
      return request('GET', `/api/bienetre/trends${buildQuery({ weeks, ...(siteId ? { siteId } : {}) })}`);
    },
    async wellbeingMyTeam() {
      return request('GET', '/api/bienetre/my-team');
    },
    async wellbeingSiteDetail(siteId) {
      return request('GET', `/api/bienetre/sites/${encodeURIComponent(siteId)}/detail`);
    },
    async wellbeingCorrelation() {
      return request('GET', '/api/bienetre/correlation');
    },
    async wellbeingSurveysList() {
      return request('GET', '/api/bienetre/surveys/list');
    },
    async wellbeingCreateSurvey(body) {
      return request('POST', '/api/bienetre/surveys', body);
    },
    async wellbeingGetSurvey(id) {
      return request('GET', `/api/bienetre/surveys/${encodeURIComponent(id)}`);
    },
    async wellbeingUpdateSurvey(id, body) {
      return request('PUT', `/api/bienetre/surveys/${encodeURIComponent(id)}`, body);
    },
    async wellbeingActivateSurvey(id) {
      return request('PUT', `/api/bienetre/surveys/${id}/activate`);
    },
    async wellbeingCloseSurvey(id) {
      return request('PUT', `/api/bienetre/surveys/${id}/close`);
    },
    async wellbeingRemindSurvey(id) {
      return request('POST', `/api/bienetre/surveys/${id}/remind`);
    },
    async wellbeingMeetings(status) {
      return request('GET', `/api/bienetre/meetings${status ? '?status=' + encodeURIComponent(status) : ''}`);
    },
    async wellbeingCreateMeeting(body) {
      return request('POST', '/api/bienetre/meetings', body);
    },
    async wellbeingUpdateMeeting(id, body) {
      return request('PATCH', `/api/bienetre/meetings/${id}`, body);
    },
    async myQcmHistory() {
      return request('GET', '/api/bienetre/my-responses');
    },

    // ── Utilisateurs / Organigramme ────────────────────────────
    async users(filters = {}) {
      return request('GET', `/api/users${buildQuery(filters)}`);
    },
    async user(id) {
      return request('GET', `/api/users/${encodeURIComponent(id)}`);
    },
    async createUser(data) {
      return request('POST', '/api/users', data);
    },
    async updateUser(id, data) {
      return request('PATCH', `/api/users/${encodeURIComponent(id)}`, data);
    },
    async resendUserInvite(id) {
      return request('POST', `/api/users/${encodeURIComponent(id)}/resend-invite`, null, true, 20000);
    },
    async resendUserInvites(payload = {}) {
      return request('POST', '/api/users/resend-invites', payload, true, 20000);
    },
    async userSites() {
      return request('GET', '/api/users/sites');
    },
    async userCatalog() {
      return request('GET', '/api/users/catalog');
    },
    async createJobPosition(name) {
      return request('POST', '/api/users/catalog/job-positions', { name });
    },
    async createOperationalPole(name) {
      return request('POST', '/api/users/catalog/operational-poles', { name });
    },
    async deleteJobPosition(id) {
      return request('DELETE', `/api/users/catalog/job-positions/${encodeURIComponent(id)}`);
    },
    async deleteOperationalPole(id) {
      return request('DELETE', `/api/users/catalog/operational-poles/${encodeURIComponent(id)}`);
    },
    async orgChart() {
      return request('GET', '/api/users/org-chart');
    },
    async mySalary(period) {
      return request('GET', `/api/users/me/salary${buildQuery({ period })}`);
    },

    // ── Internal ───────────────────────────────────────────────
    request,
    Auth,
  };

  window.api = api;
  window.Auth = Auth;
})();
