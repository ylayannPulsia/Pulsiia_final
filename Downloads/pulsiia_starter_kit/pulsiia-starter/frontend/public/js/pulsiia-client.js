// Client API Pulsiia (nom volontairement différent de « api.js » — souvent bloqué par AdBlock)

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
  const REQUEST_TIMEOUT_MS = 15000;

  function fetchWithTimeout(url, options = {}, ms = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  }

  async function refreshAccessToken() {
    if (refreshing) return refreshing;

    refreshing = fetchWithTimeout(`${API_BASE}/api/auth/refresh`, {
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
            ? 'Délai dépassé — l\'envoi des invitations prend plus de temps que prévu. Réessayez ou renvoyez par petits groupes.'
            : 'Délai dépassé — vérifiez que le backend tourne (port 3001) et PostgreSQL (docker compose up -d postgres).',
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
        response = await fetchWithTimeout(`${API_BASE}/api/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
      } catch (err) {
        if (err?.name === 'AbortError') {
          throw {
            status: 0,
            message: 'Délai dépassé — lancez le backend : cd backend && npm run dev',
          };
        }
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
      localStorage.setItem('refresh_token', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      sessionStorage.setItem('access_token', data.accessToken);
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
      localStorage.setItem('refresh_token', data.refreshToken);
      localStorage.setItem('user', JSON.stringify(data.user));
      sessionStorage.setItem('access_token', data.accessToken);
      return data.user;
    },
    async getInvitation(token) {
      return request('GET', '/api/auth/invitation?token=' + encodeURIComponent(token));
    },
    async acceptInvitation(token) {
      return request('POST', '/api/auth/accept-invitation', { token });
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
    async forgotPassword(email) {
      return request('POST', '/api/auth/forgot-password', { email });
    },
    async resetPassword(token, newPassword) {
      return request('POST', '/api/auth/reset-password', { token, newPassword });
    },
    async verify2FALogin(challengeToken, code) {
      const response = await fetch(`${API_BASE}/api/auth/2fa/verify-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, code }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw { status: response.status, error: data.error || 'Code incorrect.', ...data };
      }
      Auth.accessToken = data.accessToken;
      Auth.refreshToken = data.refreshToken;
      Auth.user = data.user;
      return data.user;
    },
    async twoFactorStatus() {
      return request('GET', '/api/auth/2fa/status');
    },
    async twoFactorSetup() {
      return request('POST', '/api/auth/2fa/setup');
    },
    async twoFactorEnable(code) {
      return request('POST', '/api/auth/2fa/enable', { code });
    },
    async twoFactorDisable(password, code) {
      return request('POST', '/api/auth/2fa/disable', { password, code });
    },
    async revokeSessions() {
      return request('POST', '/api/auth/revoke-sessions');
    },
    async checkDomain(email) { return request('POST', '/api/auth/check-domain', { email }); },

    // ── Dashboard ──────────────────────────────────────────────
    async dashboardKpis()     { return request('GET', '/api/dashboard/kpis'); },
    async dashboardActivity() { return request('GET', '/api/dashboard/activity'); },

    // ── Notifications in-app ───────────────────────────────────
    async notifications() { return request('GET', '/api/notifications'); },
    async markNotificationRead(key) {
      return request('PATCH', `/api/notifications/${encodeURIComponent(key)}/read`);
    },
    async markAllNotificationsRead() { return request('PATCH', '/api/notifications/read-all'); },

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

    // ── Feuilles d'heures (signature Yousign) ───────────────────
    async timesheets(period) {
      return request('GET', `/api/prepaie/timesheets${buildQuery({ period })}`);
    },
    async myTimesheet(period) {
      return request('GET', `/api/prepaie/timesheets/mine${buildQuery({ period })}`);
    },
    async generateTimesheets(payload) {
      return request('POST', '/api/prepaie/timesheets/generate', payload || {});
    },
    async sendTimesheetSignatures(payload) {
      return request('POST', '/api/prepaie/timesheets/send-signatures', payload || {});
    },
    async startTimesheetSignature(id) {
      return request('POST', `/api/prepaie/timesheets/${encodeURIComponent(id)}/signature`);
    },
    async timesheetSignatureStatus(id) {
      return request('GET', `/api/prepaie/timesheets/${encodeURIComponent(id)}/signature/status`);
    },
    async remindTimesheetSignature(id) {
      return request('POST', `/api/prepaie/timesheets/${encodeURIComponent(id)}/remind`);
    },
    timesheetFileUrl(id) {
      return `${API_BASE}/api/prepaie/timesheets/${encodeURIComponent(id)}/file`;
    },
    async downloadTimesheetFile(id) {
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      let response = await fetch(this.timesheetFileUrl(id), { headers });
      if (response.status === 401 && Auth.refreshToken) {
        const errBody = await response.clone().json().catch(() => ({}));
        if (errBody.code === 'TOKEN_EXPIRED') {
          await refreshAccessToken();
          headers.Authorization = `Bearer ${Auth.accessToken}`;
          response = await fetch(this.timesheetFileUrl(id), { headers });
        }
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw { status: response.status, ...data };
      }
      const blob = await response.blob();
      const filename = parseFilenameFromDisposition(response.headers.get('Content-Disposition'))
        || `feuille_heures_${id}.pdf`;
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
    async absencesBalance(userId, year) {
      return request('GET', `/api/absences/balance${buildQuery({ userId, year })}`);
    },
    async absencesCalendar(month, siteId) {
      return request('GET', `/api/absences/calendar${buildQuery({ month, siteId })}`);
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
    async uploadAbsenceFile(id, file) {
      const form = new FormData();
      form.append('file', file);
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      let response;
      try {
        response = await fetch(`${API_BASE}/api/absences/${encodeURIComponent(id)}/file`, {
          method: 'POST',
          headers,
          body: form,
        });
      } catch {
        throw { status: 0, message: 'Erreur réseau lors de l\'upload.' };
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw { status: response.status, ...data };
      return data;
    },
    async fetchAbsenceFile(id) {
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      let response;
      try {
        response = await fetch(`${API_BASE}/api/absences/${encodeURIComponent(id)}/file`, { headers });
      } catch {
        throw { status: 0, message: 'Erreur réseau lors du téléchargement.' };
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw { status: response.status, ...data };
      }
      const blob = await response.blob();
      const name = parseFilenameFromDisposition(response.headers.get('Content-Disposition'))
        || 'piece_jointe';
      return { blob, name, url: URL.createObjectURL(blob) };
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
    async createSkill(name) {
      return request('POST', '/api/users/catalog/skills', { name });
    },
    async deleteSkill(id) {
      return request('DELETE', `/api/users/catalog/skills/${encodeURIComponent(id)}`);
    },
    async deactivateUser(id) {
      return request('DELETE', `/api/users/${encodeURIComponent(id)}`);
    },
    async reactivateUser(id) {
      return request('PATCH', `/api/users/${encodeURIComponent(id)}`, { isActive: true });
    },
    async updateMyProfile(data) {
      return request('PATCH', '/api/users/me', data);
    },
    async uploadMyAvatar(file) {
      const form = new FormData();
      form.append('file', file);
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      const response = await fetch(`${API_BASE}/api/users/me/avatar`, { method: 'POST', headers, body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw { status: response.status, ...data };
      return data;
    },
    async importUsersCsv(csv) {
      return request('POST', '/api/users/import', { csv });
    },
    async myProfile() {
      return request('GET', '/api/users/me');
    },

    // ── Paramètres entreprise ──────────────────────────────────
    async companySettings() {
      return request('GET', '/api/company/settings');
    },
    async updateCompanySettings(data) {
      return request('PATCH', '/api/company/settings', data);
    },

    async createSite(data) {
      return request('POST', '/api/sites', data);
    },
    async exportUsersCsv(filters = {}) {
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      const qs = buildQuery(filters);
      const response = await fetch(`${API_BASE}/api/users/export${qs}`, { headers });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw { status: response.status, ...data };
      }
      return response.blob();
    },
    async orgChart() {
      return request('GET', '/api/users/org-chart');
    },
    async mySalary(period) {
      return request('GET', `/api/users/me/salary${buildQuery({ period })}`);
    },

    // ── Documents ──────────────────────────────────────────────
    async documents(filters = {}) {
      return request('GET', `/api/documents${buildQuery(filters)}`);
    },
    async myDocuments() {
      return request('GET', '/api/documents/mine');
    },
    async createDocument(fields, file) {
      const form = new FormData();
      Object.entries(fields || {}).forEach(([key, value]) => {
        if (value != null && value !== '') form.append(key, value);
      });
      if (file) form.append('file', file);
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      let response;
      try {
        response = await fetch(`${API_BASE}/api/documents`, {
          method: 'POST',
          headers,
          body: form,
        });
      } catch {
        throw { status: 0, message: 'Erreur réseau lors de l\'enregistrement.' };
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw { status: response.status, ...data };
      return data;
    },
    async fetchDocumentBlob(id, inline = false) {
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      const qs = inline ? '?inline=1' : '';
      const path = `/api/documents/${encodeURIComponent(id)}/file${qs}`;
      let response;
      try {
        response = await fetch(`${API_BASE}${path}`, { headers });
      } catch {
        throw { status: 0, message: 'Erreur réseau lors du téléchargement.' };
      }
      if (response.status === 401 && Auth.refreshToken) {
        const errBody = await response.clone().json().catch(() => ({}));
        if (errBody.code === 'TOKEN_EXPIRED') {
          await refreshAccessToken();
          headers.Authorization = `Bearer ${Auth.accessToken}`;
          response = await fetch(`${API_BASE}${path}`, { headers });
        }
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw { status: response.status, ...data };
      }
      const blob = await response.blob();
      const filename =
        parseFilenameFromDisposition(response.headers.get('Content-Disposition')) ||
        'document';
      const mimeType = (response.headers.get('Content-Type') || blob.type || '').split(';')[0];
      return {
        blob,
        filename,
        mimeType,
        url: URL.createObjectURL(blob),
      };
    },
    async downloadDocument(id) {
      const { filename, url } = await this.fetchDocumentBlob(id, false);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { filename, blobUrl: url };
    },
    async updateDocument(id, data) {
      return request('PUT', `/api/documents/${encodeURIComponent(id)}`, data);
    },
    async deleteDocument(id) {
      return request('DELETE', `/api/documents/${encodeURIComponent(id)}`);
    },
    async uploadMyDocument(file, name) {
      const form = new FormData();
      form.append('file', file);
      if (name) form.append('name', name);
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      let response;
      try {
        response = await fetch(`${API_BASE}/api/documents/mine`, {
          method: 'POST',
          headers,
          body: form,
        });
      } catch {
        throw { status: 0, message: 'Erreur réseau lors de l\'upload.' };
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw { status: response.status, ...data };
      return data;
    },
    async deleteMyDocument(id) {
      return request('DELETE', `/api/documents/mine/${encodeURIComponent(id)}`);
    },
    async remindDocument(id) {
      return request('POST', `/api/documents/${encodeURIComponent(id)}/remind`);
    },
    async startDocumentSignature(id) {
      return request('POST', `/api/documents/${encodeURIComponent(id)}/signature`);
    },
    async documentSignatureStatus(id) {
      return request('GET', `/api/documents/${encodeURIComponent(id)}/signature/status`);
    },
    async documentVersions(id) {
      return request('GET', `/api/documents/${encodeURIComponent(id)}/versions`);
    },
    async uploadDocumentVersion(id, file) {
      const form = new FormData();
      form.append('file', file);
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      const response = await fetch(
        `${API_BASE}/api/documents/${encodeURIComponent(id)}/versions`,
        { method: 'POST', headers, body: form },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw { status: response.status, ...data };
      return data;
    },
    async downloadDocumentsZip(filters = {}) {
      const headers = {};
      if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
      const qs = buildQuery(filters);
      const response = await fetch(`${API_BASE}/api/documents/export/zip${qs}`, { headers });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw { status: response.status, ...data };
      }
      const blob = await response.blob();
      const filename =
        parseFilenameFromDisposition(response.headers.get('Content-Disposition'))
        || 'documents_rh.zip';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { filename };
    },

    // ── Communication ──────────────────────────────────────────
    async commChannels() {
      return request('GET', '/api/communication/channels');
    },
    async commMessages(slug) {
      return request('GET', `/api/communication/channels/${encodeURIComponent(slug)}/messages`);
    },
    async sendCommMessage(slug, text, parentId, file) {
      if (file) {
        const form = new FormData();
        form.append('text', text || '');
        if (parentId) form.append('parentId', parentId);
        form.append('file', file);
        const headers = {};
        if (Auth.accessToken) headers.Authorization = `Bearer ${Auth.accessToken}`;
        const response = await fetch(`${API_BASE}/api/communication/channels/${encodeURIComponent(slug)}/messages`, {
          method: 'POST', headers, body: form,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw { status: response.status, ...data };
        return data;
      }
      return request('POST', `/api/communication/channels/${encodeURIComponent(slug)}/messages`, {
        text,
        ...(parentId ? { parentId } : {}),
      });
    },

    // ── Boîte à idées ─────────────────────────────────────────
    async ideaBoxList() {
      return request('GET', '/api/communication/ideabox');
    },
    async ideaBoxPost(text) {
      return request('POST', '/api/communication/ideabox', { text });
    },
    async ideaBoxReact(ideaId, emoji) {
      return request('POST', `/api/communication/ideabox/${encodeURIComponent(ideaId)}/react`, { emoji });
    },

    // ── RGPD ───────────────────────────────────────────────────
    async rgpdConsents() {
      return request('GET', '/api/rgpd/me/consents');
    },
    async rgpdSetConsent(type, accepted) {
      return request('POST', '/api/rgpd/me/consents', { type, accepted });
    },
    async rgpdExportData() {
      return request('POST', '/api/rgpd/me/export');
    },
    async rgpdDeletionStatus() {
      return request('GET', '/api/rgpd/me/deletion');
    },
    async rgpdRequestDeletion(reason) {
      return request('POST', '/api/rgpd/me/deletion', { reason });
    },
    async rgpdCancelDeletion() {
      return request('DELETE', '/api/rgpd/me/deletion');
    },

    // ── Push ───────────────────────────────────────────────────
    async pushPublicKey() {
      return request('GET', '/api/push/vapid-public-key');
    },
    async pushSubscribe(subscription) {
      return request('POST', '/api/push/subscribe', { subscription });
    },
    async pushUnsubscribe(endpoint) {
      return request('POST', '/api/push/unsubscribe', { endpoint });
    },
    async pushTest() {
      return request('POST', '/api/push/test');
    },

    // ── Billing ────────────────────────────────────────────────
    async billingStatus() {
      return request('GET', '/api/billing/status');
    },
    async billingInvoices() {
      return request('GET', '/api/billing/invoices');
    },
    async billingSubscribe() {
      return request('POST', '/api/billing/subscribe');
    },
    async billingGenerateInvoice() {
      return request('POST', '/api/billing/invoices/generate');
    },
    async billingPayInvoice(id) {
      return request('PUT', `/api/billing/invoices/${id}/pay`);
    },
    async billingAdminAll() {
      return request('GET', '/api/billing/admin/all');
    },

    // ── Internal ───────────────────────────────────────────────
    request,
    Auth,
  };

  window.api = api;
  window.Auth = Auth;
})();
