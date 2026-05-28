// ═══════════════════════════════════════════════════════════════
// PULSIIA — Planning IA (frontend)
// Onglet RH/Manager : génération IA hebdomadaire, conflits, validation
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';

  const DAY_LABELS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  const SHIFT_META = {
    MATIN:   { label: 'Matin',   color: '#FEF3C7', text: '#92400E', icon: '☀' },
    APREM:   { label: 'Après-midi', color: '#DBEAFE', text: '#1D4ED8', icon: '🌤' },
    NUIT:    { label: 'Nuit',    color: '#1F2937', text: '#F9FAFB', icon: '🌙' },
    JOURNEE: { label: 'Journée', color: '#E0E7FF', text: '#3730A3', icon: '🕐' },
    COUPURE: { label: 'Coupure', color: '#FFEDD5', text: '#C2410C', icon: '⏸' },
    OFF:     { label: 'Repos',   color: '#F3F4F6', text: '#6B7280', icon: '·' },
    ABSENT:  { label: 'Absent',  color: '#FEE2E2', text: '#991B1B', icon: '×' },
  };

  function shiftNetHoursClient(shift) {
    if (!shift || shift.type === 'OFF' || shift.type === 'ABSENT') return 0;
    if (!shift.startTime || !shift.endTime) {
      const defaults = { MATIN: 8, APREM: 8, NUIT: 8, JOURNEE: 8 };
      return defaults[shift.type] || 0;
    }
    const [sh, sm] = shift.startTime.split(':').map(Number);
    const [eh, em] = shift.endTime.split(':').map(Number);
    let gross = (eh * 60 + em) - (sh * 60 + sm);
    if (gross <= 0) gross += 24 * 60;
    let pause = 0;
    if (shift.breakStart && shift.breakEnd) {
      const [bsh, bsm] = shift.breakStart.split(':').map(Number);
      const [beh, bem] = shift.breakEnd.split(':').map(Number);
      let bs = bsh * 60 + bsm;
      let be = beh * 60 + bem;
      if (be <= bs) be += 24 * 60;
      pause = Math.max(0, be - bs);
    } else if (shift.breakMin) {
      pause = shift.breakMin;
    }
    return Math.max(0, gross - pause) / 60;
  }

  function formatShiftBreak(shift) {
    if (shift.breakStart && shift.breakEnd) return `⏸ ${shift.breakStart}–${shift.breakEnd}`;
    if (shift.breakMin) return `⏸ ${shift.breakMin} min`;
    return '';
  }

  const state = {
    sites: [],
    selectedSiteId: null,
    weekOffset: 0,
    weekAnchorIso: null,
    weekStart: null,
    weekData: null,
    aiStatus: null,
    isGenerating: false,
    selectedGenerateUserIds: [],
    userConstraintsById: {},
    teamSearch: '',
    teamDeptFilter: '',
    teamPage: 0,
    teamPageSize: 8,
    chatMessages: [],
    chatSending: false,
    lastExplanation: '',
  };

  const TEAM_PAGE_SIZE_OPTIONS = [5, 8, 12, 20];
  const SESSION_KEY = 'pulsiia_planning_ai_session';

  // ── Date helpers ──────────────────────────────────────────────
  function mondayOfWeek(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    const day = out.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    out.setDate(out.getDate() + diff);
    return out;
  }

  function addDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
  }

  function fmtISO(d) {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${dd}`;
  }

  function fmtFr(d) {
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  }

  function currentWeekStart() {
    if (state.weekAnchorIso) return mondayOfWeek(new Date(`${state.weekAnchorIso}T00:00:00`));
    return mondayOfWeek(addDays(new Date(), state.weekOffset * 7));
  }

  // ── DOM helpers ───────────────────────────────────────────────
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      const list = Array.isArray(children) ? children : [children];
      list.forEach((c) => {
        if (c == null || c === false) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toast(msg, type) {
    if (typeof window.showToast === 'function') return window.showToast(msg, type);
    if (typeof window.showNotification === 'function') return window.showNotification(msg, type || 'info');
    console.log(`[planning-ai] ${msg}`);
  }

  function saveStudioSession(payload) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn('[planning-ai] session save', e);
    }
  }

  function loadStudioSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function applyStudioSession(session) {
    if (!session) return false;
    state.selectedSiteId = session.siteId;
    state.weekAnchorIso = session.weekStart;
    state.weekOffset = 0;
    state.selectedGenerateUserIds = session.selectedUserIds || [];
    state.userConstraintsById = session.userConstraintsById || {};
    state.chatMessages = [];
    return true;
  }

  function siteLabel(siteId) {
    const s = state.sites.find((x) => x.id === siteId);
    return s ? s.name : 'Établissement';
  }

  // ── API loaders ───────────────────────────────────────────────
  function getApi() {
    return typeof window !== 'undefined' ? window.api : null;
  }

  async function loadAiStatus() {
    if (state.aiStatus) return state.aiStatus;
    const api = getApi();
    if (!api?.planningAiStatus) {
      state.aiStatus = { enabled: false, model: '—', mode: 'unavailable' };
      return state.aiStatus;
    }
    try {
      state.aiStatus = await api.planningAiStatus();
    } catch (err) {
      state.aiStatus = { enabled: false, model: '—', mode: 'unavailable', error: err.error || err.message };
    }
    return state.aiStatus;
  }

  async function loadSites() {
    const api = getApi();
    state.sitesLoadError = null;
    try {
      let sites = [];
      if (api?.planningAiSites) {
        const res = await api.planningAiSites();
        sites = res.sites || [];
      } else if (api?.userSites) {
        const res = await api.userSites();
        sites = (res.sites || []).map((s) => ({ ...s, activeUsers: s.activeUsers ?? 0 }));
      }
      state.sites = sites;
      if (typeof window.isManagerPlanningScoped === 'function' && window.isManagerPlanningScoped()) {
        const managerSiteId = window.Auth?.user?.siteId || window.currentUser?.siteId;
        if (managerSiteId) state.selectedSiteId = managerSiteId;
      } else if (!state.selectedSiteId && state.sites.length) {
        const def = state.sites.find((s) => s.activeUsers > 0) || state.sites[0];
        state.selectedSiteId = def.id;
      }
    } catch (err) {
      console.warn('[planning-ai] sites error', err);
      state.sites = [];
      state.sitesLoadError = err.error || err.message || 'Impossible de charger les établissements';
    }
  }

  async function loadWeek() {
    if (!state.selectedSiteId) return;
    const api = getApi();
    if (!api?.planningAiWeek) return;
    state.weekStart = currentWeekStart();
    const from = fmtISO(state.weekStart);
    try {
      state.weekData = await api.planningAiWeek(state.selectedSiteId, from);
      const employeeIds = (state.weekData?.employees || []).map((e) => e.id);
      const currentSet = new Set(state.selectedGenerateUserIds);
      const kept = employeeIds.filter((id) => currentSet.has(id));
      state.selectedGenerateUserIds = kept.length ? kept : [...employeeIds];
      const nextConstraints = {};
      for (const id of employeeIds) {
        nextConstraints[id] = String(state.userConstraintsById[id] || '');
      }
      state.userConstraintsById = nextConstraints;
      state.teamPage = 0;
    } catch (err) {
      console.warn('[planning-ai] week error', err);
      state.weekData = { siteId: state.selectedSiteId, weekStart: from, planningWeek: null, shifts: [], employees: [] };
      state.selectedGenerateUserIds = [];
      state.userConstraintsById = {};
    }
  }

  // ── Navigation liste collaborateurs (génération) ────────────
  function getTeamEmployees() {
    return state.weekData?.employees || [];
  }

  function getTeamDepartments(employees) {
    const set = new Set();
    for (const emp of employees) {
      const d = (emp.department || emp.jobTitle || '').trim();
      if (d) set.add(d);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
  }

  function getFilteredTeamEmployees() {
    const q = (state.teamSearch || '').trim().toLowerCase();
    const dept = state.teamDeptFilter || '';
    return getTeamEmployees().filter((emp) => {
      if (dept && (emp.department || emp.jobTitle || '') !== dept) return false;
      if (!q) return true;
      const hay = `${emp.firstName} ${emp.lastName} ${emp.department || ''} ${emp.jobTitle || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }

  function getTeamPageCount(filtered) {
    const n = filtered?.length || 0;
    return Math.max(1, Math.ceil(n / state.teamPageSize) || 1);
  }

  function clampTeamPage(filtered) {
    const maxPage = getTeamPageCount(filtered) - 1;
    if (state.teamPage > maxPage) state.teamPage = Math.max(0, maxPage);
    if (state.teamPage < 0) state.teamPage = 0;
  }

  function getPagedTeamEmployees(filtered) {
    clampTeamPage(filtered);
    const start = state.teamPage * state.teamPageSize;
    return filtered.slice(start, start + state.teamPageSize);
  }

  function renderTeamConfig(root) {
    const card = root.querySelector('#pai-team-config-card');
    if (!card) return;

    const all = getTeamEmployees();
    const filtered = getFilteredTeamEmployees();
    const pageItems = getPagedTeamEmployees(filtered);
    const pageCount = getTeamPageCount(filtered);
    const pageNum = state.teamPage + 1;
    const selectedInFilter = filtered.filter((e) => state.selectedGenerateUserIds.includes(e.id)).length;
    const depts = getTeamDepartments(all);

    const deptOptions = '<option value="">Tous les pôles</option>'
      + depts.map((d) => `<option value="${escapeHtml(d)}" ${state.teamDeptFilter === d ? 'selected' : ''}>${escapeHtml(d)}</option>`).join('');

    const listHtml = pageItems.length
      ? pageItems.map((emp) => `
          <div class="pai-team-row" data-user-id="${emp.id}">
            <input type="checkbox" class="pai-user-check" data-user-id="${emp.id}" ${state.selectedGenerateUserIds.includes(emp.id) ? 'checked' : ''}>
            <div class="pai-team-row-label">
              <span class="pai-team-row-name">${escapeHtml(emp.firstName)} ${escapeHtml(emp.lastName)}</span>
              <span class="pai-team-row-meta">${escapeHtml(emp.department || emp.jobTitle || '—')}</span>
            </div>
            <input type="text" class="form-input pai-user-constraint" data-user-id="${emp.id}" placeholder="ex: jeudi vendredi = repos" value="${escapeHtml(state.userConstraintsById[emp.id] || '')}">
          </div>
        `).join('')
      : `<div class="pai-team-empty">${all.length ? 'Aucun collaborateur ne correspond à la recherche.' : 'Chargez un site et une semaine.'}</div>`;

    card.innerHTML = `
      <div class="pai-team-toolbar">
        <div>
          <div style="font-size:13px;font-weight:700">Paramètres de génération</div>
          <div style="font-size:12px;color:var(--text-2)">Recherche, filtres et pages pour gérer les grandes équipes.</div>
        </div>
        <div class="pai-team-toolbar-actions">
          <button type="button" class="pai-btn-secondary pai-team-select-all" style="padding:6px 10px;font-size:12px">Tout (équipe)</button>
          <button type="button" class="pai-btn-secondary pai-team-select-filtered" style="padding:6px 10px;font-size:12px">Filtrés</button>
          <button type="button" class="pai-btn-secondary pai-team-select-page" style="padding:6px 10px;font-size:12px">Cette page</button>
          <button type="button" class="pai-btn-secondary pai-team-select-none" style="padding:6px 10px;font-size:12px">Aucun</button>
        </div>
      </div>
      <div class="pai-team-filters">
        <input type="search" id="pai-team-search" class="form-input" placeholder="Rechercher un nom, poste…" value="${escapeHtml(state.teamSearch)}">
        <select id="pai-team-dept" class="form-input">${deptOptions}</select>
        <select id="pai-team-page-size" class="form-input" title="Lignes par page">
          ${TEAM_PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${state.teamPageSize === n ? 'selected' : ''}>${n} / page</option>`).join('')}
        </select>
      </div>
      <div id="pai-team-meta" class="pai-team-meta">
        <span><strong>${selectedInFilter}</strong> sélectionné(s) sur <strong>${filtered.length}</strong> affiché(s)</span>
        <span>· ${all.length} au total</span>
        ${filtered.length !== all.length ? '<span>· filtre actif</span>' : ''}
      </div>
      <div id="pai-generate-config" class="pai-team-list">${listHtml}</div>
      <div class="pai-team-pager">
        <button type="button" class="pai-btn-secondary" id="pai-team-prev" ${state.teamPage <= 0 ? 'disabled' : ''}>‹</button>
        <span>Page <strong>${pageNum}</strong> / ${pageCount}</span>
        <button type="button" class="pai-btn-secondary" id="pai-team-next" ${state.teamPage >= pageCount - 1 ? 'disabled' : ''}>›</button>
      </div>
    `;

    bindTeamConfigEvents(root);
  }

  function bindTeamConfigEvents(root) {
    const card = root.querySelector('#pai-team-config-card');
    if (!card) return;

    card.querySelector('#pai-team-search')?.addEventListener('input', (e) => {
      state.teamSearch = e.target.value;
      state.teamPage = 0;
      renderTeamConfig(root);
    });
    card.querySelector('#pai-team-dept')?.addEventListener('change', (e) => {
      state.teamDeptFilter = e.target.value;
      state.teamPage = 0;
      renderTeamConfig(root);
    });
    card.querySelector('#pai-team-page-size')?.addEventListener('change', (e) => {
      state.teamPageSize = Math.max(5, parseInt(e.target.value, 10) || 8);
      state.teamPage = 0;
      renderTeamConfig(root);
    });
    card.querySelector('#pai-team-prev')?.addEventListener('click', () => {
      if (state.teamPage > 0) {
        state.teamPage -= 1;
        renderTeamConfig(root);
      }
    });
    card.querySelector('#pai-team-next')?.addEventListener('click', () => {
      const filtered = getFilteredTeamEmployees();
      if (state.teamPage < getTeamPageCount(filtered) - 1) {
        state.teamPage += 1;
        renderTeamConfig(root);
      }
    });

    card.querySelector('.pai-team-select-all')?.addEventListener('click', () => {
      state.selectedGenerateUserIds = getTeamEmployees().map((e) => e.id);
      renderTeamConfig(root);
    });
    card.querySelector('.pai-team-select-filtered')?.addEventListener('click', () => {
      const ids = getFilteredTeamEmployees().map((e) => e.id);
      const set = new Set(state.selectedGenerateUserIds);
      ids.forEach((id) => set.add(id));
      state.selectedGenerateUserIds = [...set];
      renderTeamConfig(root);
    });
    card.querySelector('.pai-team-select-page')?.addEventListener('click', () => {
      const ids = getPagedTeamEmployees(getFilteredTeamEmployees()).map((e) => e.id);
      const set = new Set(state.selectedGenerateUserIds);
      ids.forEach((id) => set.add(id));
      state.selectedGenerateUserIds = [...set];
      renderTeamConfig(root);
    });
    card.querySelector('.pai-team-select-none')?.addEventListener('click', () => {
      state.selectedGenerateUserIds = [];
      renderTeamConfig(root);
    });

    card.querySelectorAll('.pai-user-check').forEach((checkbox) => {
      checkbox.addEventListener('change', (e) => {
        const userId = e.target.getAttribute('data-user-id');
        if (!userId) return;
        if (e.target.checked) {
          if (!state.selectedGenerateUserIds.includes(userId)) state.selectedGenerateUserIds.push(userId);
        } else {
          state.selectedGenerateUserIds = state.selectedGenerateUserIds.filter((id) => id !== userId);
        }
        const meta = card.querySelector('#pai-team-meta');
        if (meta) {
          const filtered = getFilteredTeamEmployees();
          const selectedInFilter = filtered.filter((emp) => state.selectedGenerateUserIds.includes(emp.id)).length;
          meta.innerHTML = `
            <span><strong>${selectedInFilter}</strong> sélectionné(s) sur <strong>${filtered.length}</strong> affiché(s)</span>
            <span>· ${getTeamEmployees().length} au total</span>
            ${filtered.length !== getTeamEmployees().length ? '<span>· filtre actif</span>' : ''}
          `;
        }
      });
    });
    card.querySelectorAll('.pai-user-constraint').forEach((input) => {
      input.addEventListener('input', (e) => {
        const userId = e.target.getAttribute('data-user-id');
        if (!userId) return;
        state.userConstraintsById[userId] = String(e.target.value || '').trim();
      });
    });
  }

  // ── Renderers ─────────────────────────────────────────────────
  function renderHeader(root) {
    const week = state.weekStart || currentWeekStart();
    const weekLabel = `${fmtFr(week)} → ${fmtFr(addDays(week, 6))}`;

    const sitesOptions = state.sites.map((s) => {
      const usersLabel = typeof s.activeUsers === 'number' ? ` — ${s.activeUsers} pers.` : '';
      return `<option value="${s.id}" ${s.id === state.selectedSiteId ? 'selected' : ''}>${escapeHtml(s.name)}${usersLabel}</option>`;
    }).join('');
    const sitesPlaceholder = state.sitesLoadError
      ? `<option disabled>${escapeHtml(state.sitesLoadError)}</option>`
      : '<option disabled>Aucun site disponible</option>';

    root.innerHTML = `
      <style>
        .pai-card { background:white; border:1px solid var(--border); border-radius:14px; box-shadow:var(--shadow); padding:18px 20px; }
        .pai-grid { display:grid; grid-template-columns:120px repeat(7,1fr); gap:6px; }
        .pai-cell { padding:8px 6px; border-radius:8px; font-size:12px; text-align:center; min-height:54px; display:flex; flex-direction:column; align-items:center; justify-content:center; cursor:pointer; transition:transform .12s ease; }
        .pai-cell:hover { transform:translateY(-1px); box-shadow:0 4px 12px rgba(0,0,0,0.08); }
        .pai-cell-time { font-size:10px; opacity:.85; margin-top:2px; }
        .pai-conflict { background:#FEF2F2; border-left:3px solid #DC2626; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:6px; }
        .pai-warning { background:#FFFBEB; border-left:3px solid #D97706; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:6px; }
        .pai-suggestion { background:#EFF6FF; border-left:3px solid #2563EB; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:6px; }
        .pai-btn-primary { background:linear-gradient(135deg,#7C3AED,#4F46E5); color:white; border:none; padding:10px 18px; border-radius:10px; font-weight:600; cursor:pointer; font-family:inherit; transition:transform .12s; }
        .pai-btn-primary:hover:not(:disabled) { transform:translateY(-1px); box-shadow:0 6px 18px rgba(124,58,237,0.35); }
        .pai-btn-primary:disabled { opacity:.6; cursor:not-allowed; }
        .pai-btn-secondary { background:white; color:var(--text); border:1px solid var(--border); padding:10px 16px; border-radius:10px; font-weight:500; cursor:pointer; font-family:inherit; }
        .pai-btn-secondary:hover { background:var(--bg); }
        .pai-row-name { padding:10px 12px; background:var(--bg); border-radius:8px; font-size:12px; font-weight:500; display:flex; align-items:center; gap:8px; }
        .pai-row-avatar { width:28px; height:28px; border-radius:50%; color:white; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex-shrink:0; }
        .pai-confidence { display:inline-block; padding:2px 8px; background:rgba(255,255,255,.18); border-radius:8px; font-size:10px; }
        .pai-team-toolbar { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
        .pai-team-toolbar-actions { display:flex; gap:6px; flex-wrap:wrap; }
        .pai-team-filters { display:grid; grid-template-columns:1fr 180px 110px; gap:8px; margin-bottom:10px; }
        @media (max-width:720px) { .pai-team-filters { grid-template-columns:1fr; } }
        .pai-team-meta { font-size:12px; color:var(--text-2); margin-bottom:8px; display:flex; gap:6px; flex-wrap:wrap; }
        .pai-team-list { max-height:340px; overflow-y:auto; padding-right:4px; }
        .pai-team-row { display:grid; grid-template-columns:22px minmax(140px,200px) 1fr; gap:8px; align-items:center; margin-bottom:8px; padding:6px 4px; border-radius:8px; }
        .pai-team-row:hover { background:var(--bg); }
        .pai-team-row-label { display:flex; flex-direction:column; gap:2px; min-width:0; }
        .pai-team-row-name { font-size:12px; font-weight:600; }
        .pai-team-row-meta { font-size:11px; color:var(--text-2); }
        .pai-team-empty { font-size:12px; color:var(--text-2); padding:16px; text-align:center; }
        .pai-team-pager { display:flex; align-items:center; justify-content:center; gap:12px; margin-top:12px; padding-top:12px; border-top:1px solid var(--border); }
      </style>

      <!-- Bandeau IA -->
      <div class="pai-card" style="background:linear-gradient(135deg,#1E1B4B,#312E81);color:white;border:none;margin-bottom:14px;position:relative;overflow:hidden">
        <div style="position:absolute;top:-30px;right:-30px;width:160px;height:160px;background:radial-gradient(circle,rgba(124,58,237,.4),transparent);"></div>
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;position:relative">
          <div>
            <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:1px;opacity:.7;margin-bottom:6px">Étape 1 — Préparation</div>
            <div style="font-size:22px;font-weight:700;margin-bottom:8px">Choisissez l'équipe et les contraintes</div>
            <div style="font-size:13px;opacity:.85;max-width:680px;line-height:1.5">
              Sélectionnez les collaborateurs à planifier et décrivez leurs indisponibilités. Vous serez redirigé vers l'atelier pour générer le brouillon et l'ajuster en direct via le chat.
            </div>
          </div>
          <div style="text-align:right;flex-shrink:0">
            <div style="font-size:11px;opacity:.6;margin-bottom:4px">Semaine ciblée</div>
            <div style="font-size:18px;font-weight:600">${weekLabel}</div>
          </div>
        </div>
      </div>

      <!-- Sélecteurs + actions -->
      <div class="pai-card" style="margin-bottom:14px">
        <div style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap">
          <div style="flex:1;min-width:240px">
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Établissement</label>
            <select id="pai-site-select" class="form-input" style="width:100%">${sitesOptions || sitesPlaceholder}</select>
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Semaine</label>
            <div style="display:flex;gap:6px">
              <button class="pai-btn-secondary" id="pai-prev-week" style="padding:8px 12px">‹</button>
              <button class="pai-btn-secondary" id="pai-this-week" style="padding:8px 14px">Cette semaine</button>
              <button class="pai-btn-secondary" id="pai-next-week" style="padding:8px 12px">›</button>
            </div>
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Date semaine</label>
            <input id="pai-week-date" type="date" class="form-input" style="min-width:160px" value="${fmtISO(week)}">
          </div>
          <div style="margin-left:auto">
            <button type="button" class="pai-btn-primary" id="pai-launch-studio-btn" style="padding:12px 22px;font-size:14px">
              Continuer vers la génération →
            </button>
          </div>
        </div>
      </div>

      <div class="pai-card" id="pai-team-config-card" style="margin-bottom:14px"></div>
    `;

    renderTeamConfig(root);

    root.querySelector('#pai-site-select')?.addEventListener('change', (e) => {
      state.selectedSiteId = e.target.value || null;
      state.selectedGenerateUserIds = [];
      state.userConstraintsById = {};
      state.teamSearch = '';
      state.teamDeptFilter = '';
      state.teamPage = 0;
      reloadWeekAndRender(root);
    });
    const paiSiteSel = root.querySelector('#pai-site-select');
    if (paiSiteSel && typeof window.isManagerPlanningScoped === 'function' && window.isManagerPlanningScoped()) {
      paiSiteSel.disabled = true;
      paiSiteSel.title = 'Votre établissement — équipe gérée uniquement';
    }
    root.querySelector('#pai-prev-week')?.addEventListener('click', () => {
      if (state.weekAnchorIso) {
        state.weekAnchorIso = fmtISO(addDays(new Date(`${state.weekAnchorIso}T00:00:00`), -7));
      } else {
        state.weekOffset -= 1;
      }
      reloadWeekAndRender(root);
    });
    root.querySelector('#pai-next-week')?.addEventListener('click', () => {
      if (state.weekAnchorIso) {
        state.weekAnchorIso = fmtISO(addDays(new Date(`${state.weekAnchorIso}T00:00:00`), 7));
      } else {
        state.weekOffset += 1;
      }
      reloadWeekAndRender(root);
    });
    root.querySelector('#pai-this-week')?.addEventListener('click', () => {
      state.weekOffset = 0;
      state.weekAnchorIso = null;
      reloadWeekAndRender(root);
    });
    root.querySelector('#pai-week-date')?.addEventListener('change', (e) => {
      if (!e.target.value) return;
      state.weekAnchorIso = fmtISO(mondayOfWeek(new Date(`${e.target.value}T00:00:00`)));
      reloadWeekAndRender(root);
    });
    root.querySelector('#pai-launch-studio-btn')?.addEventListener('click', () => handleLaunchStudio(root));
  }

  function renderSummary(root) {
    const container = root.querySelector('#pai-summary');
    if (!container) return;
    const pw = state.weekData?.planningWeek;
    if (!pw) {
      container.innerHTML = `<div class="pai-card" style="text-align:center;padding:40px;border-style:dashed">
        <div style="font-size:48px;margin-bottom:10px">🤖</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:6px">Aucun planning IA pour cette semaine</div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:16px">Cliquez sur « Générer avec l'IA » pour créer un planning optimisé en quelques secondes.</div>
      </div>`;
      return;
    }

    const conflicts = Array.isArray(pw.conflicts) ? pw.conflicts : [];
    const errors = conflicts.filter((c) => c.severity === 'error').length;
    const warnings = conflicts.filter((c) => c.severity === 'warning').length;
    const confidence = pw.aiConfidence ? Math.round(pw.aiConfidence * 100) : null;
    const shiftCount = (state.weekData.shifts || []).filter((s) => s.type !== 'OFF' && s.type !== 'ABSENT').length;

    container.innerHTML = `
      <div class="pai-card" style="margin-bottom:14px;display:grid;grid-template-columns:repeat(4,1fr);gap:16px">
        <div>
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Shifts générés</div>
          <div style="font-size:24px;font-weight:700;color:#7C3AED">${shiftCount}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Confiance IA</div>
          <div style="font-size:24px;font-weight:700;color:${confidence >= 80 ? '#059669' : confidence >= 60 ? '#D97706' : '#DC2626'}">${confidence != null ? confidence + '%' : '—'}</div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Conflits</div>
          <div style="font-size:24px;font-weight:700;color:${errors ? '#DC2626' : '#059669'}">${errors}</div>
          <div style="font-size:11px;color:var(--text-2);margin-top:2px">+ ${warnings} avertissement(s)</div>
        </div>
        <div style="display:flex;flex-direction:column;justify-content:center;gap:8px">
          ${['AI_GENERATED', 'PENDING_VALIDATION', 'DRAFT'].includes(pw.status) ? `<button class="pai-btn-primary" id="pai-validate-btn">✓ Valider</button>` : ''}
          ${pw.status === 'VALIDATED' ? `<button class="pai-btn-primary" id="pai-publish-btn">📢 Publier</button>` : ''}
          ${['AI_GENERATED','PENDING_VALIDATION','DRAFT'].includes(pw.status) ? `<button class="pai-btn-secondary" id="pai-delete-btn">🗑 Annuler</button>` : ''}
        </div>
      </div>
      ${pw.aiSummary ? `<div class="pai-card" style="margin-bottom:14px;background:linear-gradient(135deg,#FAF5FF,#EFF6FF);border-color:#DDD6FE">
        <div style="display:flex;gap:10px;align-items:flex-start">
          <div style="font-size:20px">💬</div>
          <div>
            <div style="font-size:11px;font-weight:600;color:#7C3AED;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Résumé</div>
            <div style="font-size:13px;line-height:1.5;color:var(--text)">${escapeHtml(state.lastExplanation || pw.aiSummary)}</div>
          </div>
        </div>
      </div>` : (state.lastExplanation ? `<div class="pai-card" style="margin-bottom:14px;background:linear-gradient(135deg,#FAF5FF,#EFF6FF);border-color:#DDD6FE">
        <div style="display:flex;gap:10px;align-items:flex-start">
          <div style="font-size:20px">💬</div>
          <div>
            <div style="font-size:11px;font-weight:600;color:#7C3AED;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Résumé</div>
            <div style="font-size:13px;line-height:1.5;color:var(--text)">${escapeHtml(state.lastExplanation)}</div>
          </div>
        </div>
      </div>` : '')}
    `;

    container.querySelector('#pai-validate-btn')?.addEventListener('click', () => handleValidate(root));
    container.querySelector('#pai-publish-btn')?.addEventListener('click', () => handlePublish(root));
    container.querySelector('#pai-delete-btn')?.addEventListener('click', () => handleDelete(root));
  }

  function renderGrid(root) {
    const container = root.querySelector('#pai-grid-container');
    if (!container) return;
    const data = state.weekData;
    const siteName = state.sites.find((s) => s.id === state.selectedSiteId)?.name || 'cet établissement';
    if (!data || !data.employees?.length) {
      container.innerHTML = `<div class="pai-card" style="text-align:center;color:var(--text-2)">Aucun collaborateur actif sur <strong>${escapeHtml(siteName)}</strong>.</div>`;
      return;
    }

    const weekStart = new Date(`${data.weekStart}T00:00:00`);
    const shiftsByUserDate = {};
    (data.shifts || []).forEach((s) => {
      const key = `${s.userId}|${s.date}`;
      if (!shiftsByUserDate[key]) shiftsByUserDate[key] = [];
      shiftsByUserDate[key].push(s);
    });
    Object.keys(shiftsByUserDate).forEach((key) => {
      shiftsByUserDate[key].sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    });

    const conflictByUserDate = {};
    (data.planningWeek?.conflicts || []).forEach((c) => {
      if (c.userId && c.date) conflictByUserDate[`${c.userId}|${c.date}`] = c;
    });

    const weeklyHoursByUser = {};
    (data.shifts || []).forEach((s) => {
      weeklyHoursByUser[s.userId] = (weeklyHoursByUser[s.userId] || 0) + shiftNetHoursClient(s);
    });

    const headerCells = ['<div></div>'];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      headerCells.push(`<div style="text-align:center;font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;padding:6px 0">
        <div>${DAY_LABELS[i]}</div>
        <div style="font-size:13px;color:var(--text);font-weight:700;margin-top:2px">${String(d.getDate()).padStart(2,'0')}</div>
      </div>`);
    }

    const rows = data.employees.map((emp) => {
      const empName = `${emp.firstName} ${(emp.lastName || '')[0] || ''}.`;
      const initials = ((emp.firstName || '')[0] || '') + ((emp.lastName || '')[0] || '');
      const wh = weeklyHoursByUser[emp.id] || 0;
      const hsBadge = wh > 35
        ? `<span title="${wh.toFixed(0)}h planifiées — proche du seuil HS" style="font-size:9px;background:#FEF3C7;color:#92400E;padding:1px 5px;border-radius:6px;margin-left:4px">HS</span>`
        : '';
      const cells = [`<div class="pai-row-name">
        <div class="pai-row-avatar" style="background:${emp.avatarColor || '#6B7280'}">${escapeHtml(initials)}</div>
        <div style="overflow:hidden">
          <div style="font-weight:600;font-size:12px">${escapeHtml(empName)}${hsBadge}</div>
          <div style="font-size:10px;color:var(--text-3);text-transform:uppercase;letter-spacing:.3px">${escapeHtml(emp.department || emp.jobTitle || '')}</div>
        </div>
      </div>`];
      for (let i = 0; i < 7; i++) {
        const d = fmtISO(addDays(weekStart, i));
        const dayShifts = shiftsByUserDate[`${emp.id}|${d}`];
        if (!dayShifts || !dayShifts.length) {
          cells.push(`<div class="pai-cell" style="background:#F9FAFB;color:#9CA3AF;border:1px dashed #E5E7EB" data-empty="1">·</div>`);
          continue;
        }
        const workShifts = dayShifts.filter((s) => s.type !== 'OFF' && s.type !== 'ABSENT');
        const displayShifts = workShifts.length ? workShifts : dayShifts;
        const isMulti = workShifts.length > 1;
        const primary = displayShifts[0];
        const metaKey = isMulti ? 'COUPURE' : (primary.type || 'OFF');
        const meta = SHIFT_META[metaKey] || SHIFT_META.OFF;
        const conflict = conflictByUserDate[`${emp.id}|${d}`];
        const alertDot = conflict
          ? `<span title="${escapeHtml(conflict.message || 'Alerte')}" style="position:absolute;top:4px;right:4px;width:8px;height:8px;background:#DC2626;border-radius:50%"></span>`
          : '';
        const timeHtml = isMulti
          ? displayShifts.map((s) => `<div class="pai-cell-time">${s.startTime || '—'}–${s.endTime || ''}</div>`).join('')
          : (primary.startTime ? `<div class="pai-cell-time">${primary.startTime}–${primary.endTime || ''}</div>` : '');
        const breakHtml = displayShifts.map((s) => {
          const brk = formatShiftBreak(s);
          return brk ? `<div style="font-size:8px;opacity:.85">${brk}</div>` : '';
        }).join('');
        const ai = primary.isAiGenerated
          ? `<div style="font-size:8px;margin-top:2px;opacity:.7">${primary.aiConfidence ? Math.round(primary.aiConfidence * 100) + '%' : 'IA'}</div>`
          : '';
        cells.push(`<div class="pai-cell" style="background:${meta.color};color:${meta.text};position:relative;font-size:${isMulti ? '10px' : '12px'};line-height:1.25" title="${meta.label} · ${escapeHtml(empName)}${conflict ? ' · ' + escapeHtml(conflict.message) : ''}">
          ${alertDot}
          <div style="font-weight:600">${meta.icon} ${meta.label}</div>
          ${timeHtml}${breakHtml}${ai}
        </div>`);
      }
      return cells.join('');
    }).join('');

    container.innerHTML = `<div class="pai-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div>
          <div style="font-size:15px;font-weight:600">Planning semaine ${fmtFr(weekStart)} → ${fmtFr(addDays(weekStart, 6))}</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:2px">${data.employees.length} collaborateur(s) · ${(data.shifts || []).filter((s) => s.type !== 'OFF' && s.type !== 'ABSENT').length} shift(s)</div>
        </div>
      </div>
      <div class="pai-grid">${headerCells.join('')}${rows}</div>
    </div>`;
  }

  function renderInsights(root) {
    const container = root.querySelector('#pai-insights');
    if (!container) return;
    const pw = state.weekData?.planningWeek;
    if (!pw) { container.innerHTML = ''; return; }

    const conflicts = Array.isArray(pw.conflicts) ? pw.conflicts : [];
    const errors = conflicts.filter((c) => c.severity === 'error');
    const warnings = conflicts.filter((c) => c.severity === 'warning');
    const sugg = pw.aiSuggestions?.suggestions || [];
    const warn = pw.aiSuggestions?.warnings || [];
    const coverage = pw.coverage || {};

    if (!errors.length && !warnings.length && !sugg.length && !warn.length && !(coverage.understaffedSlots || []).length) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `<div class="pai-card">
      <div style="font-size:14px;font-weight:600;margin-bottom:12px;display:flex;align-items:center;gap:8px">
        <span style="font-size:18px">🧠</span> Analyse de l'IA
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <div style="font-size:11px;font-weight:700;color:#DC2626;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Conflits légaux (${errors.length})</div>
          ${errors.length
            ? errors.map((c) => `<div class="pai-conflict"><strong>${escapeHtml(c.employeeName || c.type)}</strong> — ${escapeHtml(c.message)}</div>`).join('')
            : '<div style="font-size:12px;color:var(--text-2);font-style:italic">Aucun conflit légal détecté ✓</div>'}
          ${warnings.length ? `<div style="font-size:11px;font-weight:700;color:#D97706;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px">Avertissements (${warnings.length})</div>` + warnings.map((c) => `<div class="pai-warning"><strong>${escapeHtml(c.employeeName || c.type)}</strong> — ${escapeHtml(c.message)}</div>`).join('') : ''}
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;color:#2563EB;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Suggestions IA (${sugg.length})</div>
          ${sugg.length
            ? sugg.map((s) => `<div class="pai-suggestion">${escapeHtml(s)}</div>`).join('')
            : '<div style="font-size:12px;color:var(--text-2);font-style:italic">L\'IA n\'a pas émis de suggestion.</div>'}
          ${warn.length ? `<div style="font-size:11px;font-weight:700;color:#D97706;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px">Mises en garde</div>` + warn.map((s) => `<div class="pai-warning">${escapeHtml(s)}</div>`).join('') : ''}
          ${(coverage.understaffedSlots || []).length ? `<div style="font-size:11px;font-weight:700;color:#DC2626;text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px">Couverture insuffisante</div>` + (coverage.understaffedSlots || []).map((s) => `<div class="pai-conflict">${escapeHtml(s)}</div>`).join('') : ''}
        </div>
      </div>
    </div>`;
  }

  // ── Actions ───────────────────────────────────────────────────
  function buildGenerationPayload() {
    const weekStart = fmtISO(currentWeekStart());
    const employees = state.weekData?.employees || [];
    const employeeIdSet = new Set(employees.map((e) => e.id));
    const selectedUserIds = state.selectedGenerateUserIds.filter((id) => employeeIdSet.has(id));
    const userConstraints = selectedUserIds
      .map((userId) => ({ userId, text: String(state.userConstraintsById[userId] || '').trim() }))
      .filter((c) => c.text);
    return { weekStart, selectedUserIds, userConstraints };
  }

  function handleLaunchStudio(setupRoot) {
    if (!state.selectedSiteId) { toast('Sélectionnez un établissement', 'error'); return; }
    const { weekStart, selectedUserIds, userConstraints } = buildGenerationPayload();
    if (!selectedUserIds.length) {
      toast('Sélectionnez au moins une personne à planifier.', 'error');
      return;
    }
    saveStudioSession({
      siteId: state.selectedSiteId,
      weekStart,
      selectedUserIds,
      userConstraints,
      userConstraintsById: { ...state.userConstraintsById },
    });
    if (typeof showPage === 'function') {
      showPage('planning-ai-studio', document.getElementById('nav-planning-ai'));
    }
  }

  async function runStudioGeneration(root, session) {
    const api = getApi();
    if (!api?.planningAiGenerate) {
      toast('Génération IA indisponible', 'error');
      return;
    }
    state.isGenerating = true;
    renderStudioShell(root, { loading: true });

    try {
      toast('Génération du brouillon en cours…', 'info');
      const result = await api.planningAiGenerate(
        session.siteId,
        session.weekStart,
        {
          selectedUserIds: session.selectedUserIds,
          userConstraints: session.userConstraints,
        },
      );
      state.weekData = await api.planningAiWeek(session.siteId, session.weekStart);
      state.lastExplanation = result.explanation || result.summary || '';
      const coverage = result.stats?.coverageRate ?? result.coverage?.coverageRate;
      state.chatMessages = [{
        role: 'assistant',
        text: state.lastExplanation || `Brouillon généré · ${result.shifts.length} shifts · couverture ${coverage != null ? coverage + '%' : '—'} · ${result.conflicts.length} conflit(s). Décrivez vos modifications dans le chat.`,
      }];
      toast(`Brouillon créé`, 'success');
    } catch (err) {
      console.error(err);
      const detail = Array.isArray(err.details) && err.details[0]?.message;
      toast(detail || err.error || err.message || 'Erreur génération.', 'error');
      state.chatMessages = [{
        role: 'assistant',
        text: 'La génération a échoué. Vous pouvez réessayer depuis la préparation ou reformuler une demande simple dans le chat.',
      }];
    } finally {
      state.isGenerating = false;
      renderStudioShell(root);
      renderStudioPage(root);
    }
  }

  async function handleChatSend(root) {
    const api = getApi();
    const input = root.querySelector('#pai-chat-input');
    const text = (input?.value || '').trim();
    if (!text || state.chatSending) return;
    if (!api?.planningAiChat) { toast('Chat indisponible', 'error'); return; }

    const session = loadStudioSession();
    if (!session) return;

    state.chatMessages.push({ role: 'user', text });
    if (input) input.value = '';
    state.chatSending = true;
    renderChatPanel(root);

    try {
      const pwId = state.weekData?.planningWeek?.id;
      const res = await api.planningAiChat(session.siteId, session.weekStart, text, pwId, {
        selectedUserIds: session.selectedUserIds,
      });
      state.weekData = res.weekData || state.weekData;
      state.lastExplanation = res.reply || state.lastExplanation;
      state.chatMessages.push({
        role: 'assistant',
        text: res.reply || 'Modification traitée.',
      });
      if ((res.adjustments || []).length) {
        toast(`${res.adjustments.length} ajustement(s) appliqué(s) au brouillon`, 'success');
      }
      renderStudioPage(root);
    } catch (err) {
      const raw = String(err.error || err.message || '');
      let text = 'Erreur lors du traitement de votre message.';
      if (/usage limits|invalid_request_error|quota/i.test(raw)) {
        text = 'Quota API IA temporairement atteint. Reformulez par exemple : « Refaire le planning en respectant les contraintes légales » — le recalcul se fera en mode local.';
      } else if (raw && raw.length < 280 && !raw.startsWith('{')) {
        text = raw;
      }
      state.chatMessages.push({ role: 'assistant', text });
      renderChatPanel(root);
    } finally {
      state.chatSending = false;
      renderChatPanel(root);
    }
  }

  function renderChatPanel(root) {
    const box = root.querySelector('#pai-chat-messages');
    if (!box) return;
    if (!state.chatMessages.length) {
      box.innerHTML = `<div class="pai-chat-hint">Exemples : « Refaire en respectant les contraintes légales » · « Mettre Sophie en repos vendredi »</div>`;
      return;
    }
    box.innerHTML = state.chatMessages.map((m) => `
      <div class="pai-chat-bubble pai-chat-${m.role}">
        <div class="pai-chat-role">${m.role === 'user' ? 'Vous' : 'Assistant IA'}</div>
        <div>${escapeHtml(m.text)}</div>
      </div>
    `).join('') + (state.chatSending ? `<div class="pai-chat-bubble pai-chat-assistant"><div class="pai-chat-role">Assistant IA</div><div>⏳ Analyse en cours…</div></div>` : '');
    box.scrollTop = box.scrollHeight;
  }

  function renderStudioShell(root, opts) {
    const loading = opts?.loading;
    const session = loadStudioSession();
    const week = session?.weekStart ? new Date(`${session.weekStart}T00:00:00`) : currentWeekStart();
    const weekLabel = `${fmtFr(week)} → ${fmtFr(addDays(week, 6))}`;

    root.innerHTML = `
      <style>
        .pai-card { background:white; border:1px solid var(--border); border-radius:14px; box-shadow:var(--shadow); padding:18px 20px; }
        .pai-grid { display:grid; grid-template-columns:120px repeat(7,1fr); gap:6px; }
        .pai-cell { padding:8px 6px; border-radius:8px; font-size:12px; text-align:center; min-height:54px; display:flex; flex-direction:column; align-items:center; justify-content:center; }
        .pai-cell-time { font-size:10px; opacity:.85; margin-top:2px; }
        .pai-conflict { background:#FEF2F2; border-left:3px solid #DC2626; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:6px; }
        .pai-warning { background:#FFFBEB; border-left:3px solid #D97706; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:6px; }
        .pai-suggestion { background:#EFF6FF; border-left:3px solid #2563EB; padding:8px 12px; border-radius:6px; font-size:12px; margin-bottom:6px; }
        .pai-btn-primary { background:linear-gradient(135deg,#7C3AED,#4F46E5); color:white; border:none; padding:10px 18px; border-radius:10px; font-weight:600; cursor:pointer; font-family:inherit; }
        .pai-btn-primary:disabled { opacity:.6; cursor:not-allowed; }
        .pai-btn-secondary { background:white; color:var(--text); border:1px solid var(--border); padding:10px 16px; border-radius:10px; font-weight:500; cursor:pointer; font-family:inherit; }
        .pai-row-name { padding:10px 12px; background:var(--bg); border-radius:8px; font-size:12px; font-weight:500; display:flex; align-items:center; gap:8px; }
        .pai-row-avatar { width:28px; height:28px; border-radius:50%; color:white; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:600; flex-shrink:0; }
        .pai-studio-layout { display:grid; grid-template-columns:1fr 340px; gap:14px; align-items:start; }
        @media (max-width:1100px) { .pai-studio-layout { grid-template-columns:1fr; } }
        .pai-studio-chat { display:flex; flex-direction:column; min-height:520px; max-height:calc(100vh - 200px); }
        .pai-chat-messages { flex:1; overflow-y:auto; padding:12px; background:var(--bg); border-radius:10px; margin-bottom:10px; min-height:280px; }
        .pai-chat-bubble { padding:10px 12px; border-radius:10px; margin-bottom:8px; font-size:13px; line-height:1.45; }
        .pai-chat-user { background:#EDE9FE; margin-left:24px; }
        .pai-chat-assistant { background:white; border:1px solid var(--border); margin-right:24px; }
        .pai-chat-role { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.4px; color:var(--text-3); margin-bottom:4px; }
        .pai-chat-hint { font-size:12px; color:var(--text-2); padding:8px; }
        .pai-chat-form { display:flex; flex-direction:column; gap:8px; }
        .pai-chat-form textarea { resize:vertical; min-height:72px; font-family:inherit; font-size:13px; }
      </style>
      <div class="pai-card" style="margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
        <div>
          <button type="button" class="pai-btn-secondary" id="pai-back-setup" style="margin-bottom:8px">← Modifier l'équipe</button>
          <div style="font-size:13px;font-weight:700">Atelier Planning IA <span style="color:var(--text-3);font-weight:500">— Étape 2/2</span></div>
          <div style="font-size:12px;color:var(--text-2)">${escapeHtml(siteLabel(session?.siteId))} · ${weekLabel} · ${(session?.selectedUserIds || []).length} personne(s)</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap" id="pai-studio-actions"></div>
      </div>
      <div class="pai-studio-layout">
        <div class="pai-studio-main">
          ${loading ? `<div class="pai-card" style="text-align:center;padding:64px"><div style="font-size:32px">⏳</div><div style="margin-top:10px;color:var(--text-2)">Génération du planning brouillon…</div></div>` : `
            <div id="pai-summary"></div>
            <div id="pai-grid-container"></div>
            <div id="pai-insights" style="margin-top:14px"></div>
          `}
        </div>
        <aside class="pai-card pai-studio-chat">
          <div style="font-size:13px;font-weight:700;margin-bottom:8px">💬 Assistant planning</div>
          <div style="font-size:11px;color:var(--text-2);margin-bottom:10px">Modifiez le brouillon en langage naturel. Les changements sont appliqués immédiatement.</div>
          <div id="pai-chat-messages" class="pai-chat-messages"></div>
          <form class="pai-chat-form" id="pai-chat-form" onsubmit="return false">
            <textarea id="pai-chat-input" class="form-input" placeholder="Ex: mettre Léa en repos vendredi…" rows="3"></textarea>
            <button type="button" class="pai-btn-primary" id="pai-chat-send" ${state.chatSending ? 'disabled' : ''}>Envoyer</button>
          </form>
        </aside>
      </div>
    `;

    root.querySelector('#pai-back-setup')?.addEventListener('click', () => {
      if (typeof showPage === 'function') showPage('planning-ai', document.getElementById('nav-planning-ai'));
    });
    root.querySelector('#pai-chat-send')?.addEventListener('click', () => handleChatSend(root));
    root.querySelector('#pai-chat-form')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleChatSend(root);
      }
    });

    const actions = root.querySelector('#pai-studio-actions');
    if (actions && !loading) {
      const pw = state.weekData?.planningWeek;
      actions.innerHTML = `
        ${pw && ['AI_GENERATED', 'PENDING_VALIDATION', 'DRAFT'].includes(pw.status) ? '<button class="pai-btn-primary" id="pai-validate-btn">✓ Valider</button>' : ''}
        ${pw && pw.status === 'VALIDATED' ? '<button class="pai-btn-primary" id="pai-publish-btn">📢 Publier</button>' : ''}
        ${pw && ['AI_GENERATED', 'PENDING_VALIDATION', 'DRAFT'].includes(pw.status) ? '<button class="pai-btn-secondary" id="pai-delete-btn">🗑 Annuler</button>' : ''}
        <button class="pai-btn-secondary" id="pai-regenerate-btn">↻ Regénérer</button>
      `;
      actions.querySelector('#pai-validate-btn')?.addEventListener('click', () => handleValidate(root));
      actions.querySelector('#pai-publish-btn')?.addEventListener('click', () => handlePublish(root));
      actions.querySelector('#pai-delete-btn')?.addEventListener('click', () => handleDelete(root));
      actions.querySelector('#pai-regenerate-btn')?.addEventListener('click', () => {
        const s = loadStudioSession();
        if (s) runStudioGeneration(root, s);
      });
    }
  }

  function renderStudioPage(root) {
    renderSummary(root);
    renderGrid(root);
    renderInsights(root);
    renderChatPanel(root);
  }

  async function handleValidate(root) {
    const api = getApi();
    const pw = state.weekData?.planningWeek;
    if (!pw || !api?.planningAiValidate) return;
    if (!confirm('Valider ce planning ? Les shifts deviennent officiels et la pré-paie sera synchronisée.')) return;
    try {
      await api.planningAiValidate(pw.id);
      toast('Planning validé ✓ · pré-paie synchronisée.', 'success');
      if (typeof window.invalidatePlanningCache === 'function') window.invalidatePlanningCache();
      await reloadWeekAndRender(root);
    } catch (err) {
      toast(err.error || err.message || 'Erreur de validation.', 'error');
    }
  }

  async function handlePublish(root) {
    const api = getApi();
    const pw = state.weekData?.planningWeek;
    if (!pw || !api?.planningAiPublish) return;
    try {
      await api.planningAiPublish(pw.id);
      toast('Planning publié — les collaborateurs sont notifiés.', 'success');
      if (typeof window.invalidatePlanningCache === 'function') window.invalidatePlanningCache();
      await reloadWeekAndRender(root);
    } catch (err) {
      toast(err.error || err.message || 'Erreur de publication.', 'error');
    }
  }

  async function handleDelete(root) {
    const api = getApi();
    const pw = state.weekData?.planningWeek;
    if (!pw || !api?.planningAiDelete) return;
    if (!confirm('Annuler cette génération IA ? Les shifts générés par l\'IA seront supprimés.')) return;
    try {
      await api.planningAiDelete(pw.id);
      toast('Génération IA annulée.', 'success');
      await reloadWeekAndRender(root);
    } catch (err) {
      toast(err.error || err.message || 'Erreur de suppression.', 'error');
    }
  }

  async function handleOptimize(root) {
    const api = getApi();
    if (!state.weekData?.planningWeek) { toast('Aucun planning à optimiser. Générez-en un d\'abord.', 'error'); return; }
    const issue = prompt('Décrivez le problème à résoudre (ex: "Thomas est absent vendredi, qui peut le remplacer ?")');
    if (!issue || issue.trim().length < 5) return;
    try {
      toast('Analyse IA en cours…', 'info');
      const result = await api.planningAiOptimize(state.selectedSiteId, fmtISO(currentWeekStart()), issue.trim());
      const lines = [
        result.explanation || 'Aucune explication fournie.',
        '',
        ...(result.adjustments || []).map((a) => `• ${a.action} — ${a.userId || ''} le ${a.date || ''} (${a.type || ''}) — ${a.reason || ''}`),
      ];
      alert(lines.join('\n'));
    } catch (err) {
      toast(err.error || err.message || 'Erreur d\'optimisation.', 'error');
    }
  }

  function renderPage(root) {
    renderStudioPage(root);
  }

  /** Recharge planning (atelier) ou équipe (préparation). */
  async function reloadWeekAndRender(root) {
    if (!root) return;
    if (!state.selectedSiteId) {
      state.weekData = null;
      if (root.id === 'planning-ai-studio-root') renderStudioPage(root);
      else renderHeader(root);
      return;
    }
    const isStudio = root.id === 'planning-ai-studio-root';
    if (isStudio) {
      const gridEl = root.querySelector('#pai-grid-container');
      const summaryEl = root.querySelector('#pai-summary');
      const loading = '<div class="pai-card" style="text-align:center;padding:32px;color:var(--text-2)">Chargement…</div>';
      if (gridEl) gridEl.innerHTML = loading;
      if (summaryEl) summaryEl.innerHTML = loading;
    }
    state.weekData = null;
    await loadWeek();
    if (isStudio) {
      renderStudioShell(root);
      renderStudioPage(root);
    } else {
      renderHeader(root);
    }
  }

  async function loadSetupPage(root) {
    root.innerHTML = `<div class="pai-card" style="text-align:center;padding:48px">
      <div style="font-size:32px;margin-bottom:10px">⏳</div>
      <div style="font-size:14px;color:var(--text-2)">Chargement…</div>
    </div>`;
    await Promise.all([loadAiStatus(), loadSites()]);
    await loadWeek();
    renderHeader(root);
  }

  async function loadStudioPage(root) {
    const session = loadStudioSession();
    if (!session) {
      toast('Configurez d\'abord l\'équipe sur la page Préparation.', 'error');
      if (typeof showPage === 'function') showPage('planning-ai', document.getElementById('nav-planning-ai'));
      return;
    }
    applyStudioSession(session);
    await loadAiStatus();
    await loadSites();

    // Si un planning existe déjà pour cette semaine, on l'affiche sans regénérer.
    const api = getApi();
    if (api?.planningAiWeek) {
      try {
        const existing = await api.planningAiWeek(session.siteId, session.weekStart);
        if (existing?.planningWeek) {
          state.weekData = existing;
          renderStudioShell(root);
          renderStudioPage(root);
          return;
        }
      } catch (e) {
        // Ignore — on génère quand même si la requête échoue
      }
    }

    await runStudioGeneration(root, session);
  }

  // ── Hook into showPage ────────────────────────────────────────
  function patchShowPage() {
    if (typeof showPage !== 'function' || showPage.__planAiPatched) return;
    const orig = window.showPage;
    window.showPage = function (name, navEl) {
      orig(name, navEl);
      if (name === 'planning-ai') {
        const root = document.getElementById('planning-ai-root');
        if (root) loadSetupPage(root);
      }
      if (name === 'planning-ai-studio') {
        const root = document.getElementById('planning-ai-studio-root');
        if (root) loadStudioPage(root);
      }
    };
    window.showPage.__planAiPatched = true;
  }

  function init() {
    if (typeof showPage !== 'function') {
      setTimeout(init, 50);
      return;
    }
    patchShowPage();
  }

  window.PulsiiaPlanningAi = {
    refresh: () => {
      const studioRoot = document.getElementById('planning-ai-studio-root');
      if (studioRoot) loadStudioPage(studioRoot);
      else {
        const root = document.getElementById('planning-ai-root');
        if (root) loadSetupPage(root);
      }
    },
    goToStudio: () => {
      const root = document.getElementById('planning-ai-root');
      if (root) handleLaunchStudio(root);
    },
    state,
  };

  init();
})();
