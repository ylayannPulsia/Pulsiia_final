/* Pulsiia — SPA logic with real API */
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let _user = null;           // current user object
let _channels = [];         // loaded channels
let _activeChanId = null;   // active communication channel
let _planWeekStart = null;  // ISO week start string
let _absPage = 1;           // absences pagination
let _ppPage = 1;            // prepaie pagination

// ── Init ──────────────────────────────────────────────────────────────────────
async function initApp() {
  // Tenter l'auth réelle, sinon continuer en mode démo
  try {
    const ok = await API.initAuth();
    if (ok) _user = await API.me();
  } catch {}

  if (!_user) {
    _user = {
      id: 'demo', email: 'marie.lambert@saveurs-co.fr',
      firstName: 'Marie', lastName: 'Lambert',
      role: 'DRH', companyId: 'demo', primarySiteId: 'demo',
    };
  }

  setupUserUI();
  setupRoleNav();
  const first = isCollaborateur() ? 'accueil-collab' : 'dashboard';
  showPage(first, document.querySelector(`.nav-item[data-page="${first}"]`));
  loadNotifBadges();
}

function isCollaborateur() { return _user.role === 'COLLABORATEUR'; }
function isManagerPlus()   { return ['MANAGER','RH','DRH','ADMIN'].includes(_user.role); }
function isRHPlus()        { return ['RH','DRH','ADMIN'].includes(_user.role); }
function isDRHPlus()       { return ['DRH','ADMIN'].includes(_user.role); }

function setupUserUI() {
  const initials = (_user.firstName[0] + _user.lastName[0]).toUpperCase();
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent   = `${_user.firstName} ${_user.lastName}`;
  document.getElementById('user-role-label').textContent = _user.role;
}

function setupRoleNav() {
  if (isCollaborateur()) {
    document.querySelectorAll('.rh-only').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.collab-only').forEach(el => el.style.display = '');
  } else {
    document.querySelectorAll('.rh-only').forEach(el => el.style.display = '');
    document.querySelectorAll('.collab-only').forEach(el => el.style.display = 'none');
  }
}

async function loadNotifBadges() {
  try {
    const kpis = await API.kpis();
    if (kpis.pendingAbsences > 0)
      document.getElementById('badge-absences').textContent = kpis.pendingAbsences;
    if (kpis.pendingPayVars > 0)
      document.getElementById('badge-prepaie').textContent = kpis.pendingPayVars;
  } catch {}
}

// ── Router ────────────────────────────────────────────────────────────────────
const PAGE_TITLES = {
  dashboard: 'Tableau de bord', planning: 'Planning', absences: 'Absences & Congés',
  prepaie: 'Pré-paie', bienetre: 'Bien-être', communication: 'Communication',
  collaborateurs: 'Collaborateurs', settings: 'Paramètres',
  'accueil-collab': 'Accueil', 'mon-planning': 'Mon planning',
};

function showPage(name, navEl) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pg = document.getElementById('page-' + name);
  if (pg) pg.classList.add('active');
  if (navEl) navEl.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[name] || name;

  if      (name === 'dashboard')     loadDashboard();
  else if (name === 'planning')      loadPlanning();
  else if (name === 'absences')      loadAbsences();
  else if (name === 'prepaie')       loadPrepaie();
  else if (name === 'bienetre')      loadBienetre();
  else if (name === 'communication') loadComm();
  else if (name === 'collaborateurs') loadCollabs();
  else if (name === 'accueil-collab') loadCollabHome();
  else if (name === 'mon-planning')  loadMonPlanning();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.remove('show'), 3200);
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}

function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
}

// ── Logout ────────────────────────────────────────────────────────────────────
async function doLogout() {
  await API.logout();
  window.location.replace('/login.html');
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────────────────
async function loadDashboard() {
  document.getElementById('dash-kpis').innerHTML = '<div class="loading">Chargement…</div>';

  try {
    const [kpis, activity] = await Promise.all([API.kpis(), API.activity(10)]);
    renderKPIs(kpis);
    renderActivity(activity);
  } catch (e) {
    document.getElementById('dash-kpis').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

function renderKPIs(k) {
  document.getElementById('dash-kpis').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Collaborateurs actifs</div>
      <div class="kpi-value">${k.activeUsers}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Absences en attente</div>
      <div class="kpi-value" style="color:${k.pendingAbsences > 0 ? 'var(--orange)' : 'var(--text)'}">${k.pendingAbsences}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Variables pré-paie</div>
      <div class="kpi-value">${k.pendingPayVars}<span>à valider</span></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Bien-être moyen</div>
      <div class="kpi-value">${k.wellness?.score != null ? Number(k.wellness.score).toFixed(1) : '—'}<span style="font-size:12px">/10</span></div>
    </div>
  `;
}

function renderActivity(items) {
  const el = document.getElementById('dash-activity');
  if (!items || !items.length) { el.innerHTML = '<div style="padding:16px;color:var(--text-2);font-size:13px">Aucune activité récente.</div>'; return; }
  el.innerHTML = items.map(a => {
    const name = a.user ? `${a.user.firstName} ${a.user.lastName}` : 'Système';
    const init = name.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase();
    const dt = new Date(a.createdAt);
    const ago = fmtAgo(dt);
    return `<div class="activity-item">
      <div class="activity-avatar" style="background:var(--blue)">${init}</div>
      <div class="activity-text"><strong>${name}</strong> ${a.action.toLowerCase().replace(/_/g,' ')}</div>
      <div class="activity-time">${ago}</div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// PLANNING
// ─────────────────────────────────────────────────────────────────────────────
async function loadPlanning(weekStart) {
  if (weekStart) _planWeekStart = weekStart;
  document.getElementById('plan-rows').innerHTML = '<tr><td colspan="8" class="loading">Chargement…</td></tr>';

  try {
    const data = await API.planningWeek(_planWeekStart);
    _planWeekStart = data.weekStart;
    renderPlanning(data);
  } catch (e) {
    document.getElementById('plan-rows').innerHTML = `<tr><td colspan="8" class="error-msg">${e.message}</td></tr>`;
  }
}

function renderPlanning(data) {
  const days = data.days; // [{date, label, isToday}]
  const users = data.users; // [{id, firstName, lastName, role, shifts:[{dayIndex, type, startsAt, endsAt}]}]

  // Update week label
  document.getElementById('week-label').textContent = data.weekLabel || '';

  // Header
  document.getElementById('plan-header').innerHTML =
    '<th class="ph-cell" style="text-align:left">Collaborateur</th>'
    + days.map(d => `<th class="ph-cell${d.isToday ? ' today' : ''}">${d.label}</th>`).join('');

  // Rows
  document.getElementById('plan-rows').innerHTML = users.map(u => {
    const initials = (u.firstName[0] + u.lastName[0]).toUpperCase();
    const cells = days.map((d, i) => {
      const shift = u.shifts.find(s => s.dayIndex === i);
      if (!shift) return `<td class="pr-cell"><div class="shift empty" onclick="openShiftNew('${u.id}',${i})">+</div></td>`;
      const label = fmtShiftLabel(shift);
      const cls   = shift.type.toLowerCase().replace('_','');
      return `<td class="pr-cell"><div class="shift ${cls}" onclick="openShiftEdit('${shift.id}','${u.firstName} ${u.lastName}',${i})">${label}</div></td>`;
    }).join('');
    return `<tr class="planning-row">
      <td class="pr-name">
        <div class="pr-avatar" style="background:var(--blue)">${initials}</div>
        <div><div class="pr-label">${u.firstName} ${u.lastName}</div>
        <div class="pr-sub">${u.role}</div></div>
      </td>${cells}</tr>`;
  }).join('');
}

function fmtShiftLabel(s) {
  if (!s.startsAt) return s.type;
  const st = new Date(s.startsAt), en = new Date(s.endsAt);
  return `${st.getUTCHours()}h–${en.getUTCHours()}h`;
}

function planChangeWeek(dir) {
  if (!_planWeekStart) return;
  const d = new Date(_planWeekStart);
  d.setUTCDate(d.getUTCDate() + dir * 7);
  loadPlanning(d.toISOString().slice(0, 10));
}

// Shift modal
let _shiftCtx = null; // {mode:'new'|'edit', userId, shiftId, dayIndex}

function openShiftNew(userId, dayIndex) {
  if (!isManagerPlus()) return;
  _shiftCtx = { mode: 'new', userId, dayIndex };
  document.getElementById('shift-modal-title').textContent = 'Nouveau shift';
  document.getElementById('shift-date').value = getDayDate(dayIndex);
  document.getElementById('shift-start').value = '09:00';
  document.getElementById('shift-end').value   = '17:00';
  openModal('modal-shift');
}

function openShiftEdit(shiftId, userName, dayIndex) {
  if (!isManagerPlus()) return;
  _shiftCtx = { mode: 'edit', shiftId, dayIndex };
  document.getElementById('shift-modal-title').textContent = userName;
  openModal('modal-shift');
}

function getDayDate(dayIndex) {
  if (!_planWeekStart) return '';
  const d = new Date(_planWeekStart);
  d.setUTCDate(d.getUTCDate() + dayIndex);
  return d.toISOString().slice(0, 10);
}

async function saveShift() {
  const start  = document.getElementById('shift-start').value;
  const end    = document.getElementById('shift-end').value;
  const date   = document.getElementById('shift-date').value;
  if (!start || !end || !date) { showToast('Champs manquants', 'error'); return; }

  const [sh,sm] = start.split(':').map(Number);
  const [eh,em] = end.split(':').map(Number);
  const startsAt = new Date(date + 'T' + start + ':00Z').toISOString();
  let endDate = date;
  if (eh < sh || (eh === sh && em < sm)) {
    const d = new Date(date); d.setUTCDate(d.getUTCDate() + 1);
    endDate = d.toISOString().slice(0, 10);
  }
  const endsAt = new Date(endDate + 'T' + end + ':00Z').toISOString();

  try {
    if (_shiftCtx?.mode === 'new') {
      await API.createShift({ userId: _shiftCtx.userId, siteId: _user.primarySiteId, startsAt, endsAt });
    } else {
      await API.updateShift(_shiftCtx.shiftId, { startsAt, endsAt });
    }
    closeModal('modal-shift');
    showToast('Shift enregistré ✓');
    loadPlanning();
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteShift() {
  if (!_shiftCtx?.shiftId) return;
  try {
    await API.deleteShift(_shiftCtx.shiftId);
    closeModal('modal-shift');
    showToast('Shift supprimé');
    loadPlanning();
  } catch (e) { showToast(e.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// ABSENCES
// ─────────────────────────────────────────────────────────────────────────────
let _absFilter = 'all';

async function loadAbsences() {
  document.getElementById('abs-body').innerHTML = '<tr><td colspan="7" class="loading">Chargement…</td></tr>';
  try {
    const params = { page: _absPage, limit: 15 };
    if (_absFilter !== 'all') params.status = _absFilter;
    const [data, stats] = await Promise.all([API.absences(params), API.absenceStats()]);
    renderAbsStats(stats);
    renderAbsTable(data);
  } catch (e) {
    document.getElementById('abs-body').innerHTML = `<tr><td colspan="7" class="error-msg">${e.message}</td></tr>`;
  }
}

function renderAbsStats(s) {
  document.getElementById('abs-kpi-pending').textContent  = s.pending || 0;
  document.getElementById('abs-kpi-approved').textContent = s.byStatus?.APPROVED || 0;
  document.getElementById('abs-kpi-rejected').textContent = s.byStatus?.REJECTED || 0;
}

const ABS_TYPE_FR = { CP:'Congé payé', RTT:'RTT', MALADIE:'Maladie', MATERNITE:'Maternité', PATERNITE:'Paternité',
  FORMATION:'Formation', ACCIDENT_TRAVAIL:'Accident travail', MALADIE_PRO:'Maladie pro',
  ENFANT_MALADE:'Enfant malade', CONGE_SANS_SOLDE:'Congé sans solde',
  EVENEMENT_FAMILIAL:'Évén. familial', AUTRE:'Autre' };

function renderAbsTable(data) {
  const abs = data.absences || data;
  if (!abs.length) {
    document.getElementById('abs-body').innerHTML = '<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--text-2)">Aucune absence.</td></tr>';
    return;
  }
  document.getElementById('abs-body').innerHTML = abs.map(a => {
    const user = a.user ? `${a.user.firstName} ${a.user.lastName}` : '—';
    const type = ABS_TYPE_FR[a.type] || a.type;
    const from = fmtDate(a.startsAt), to = fmtDate(a.endsAt);
    const badge = statusBadge(a.status);
    const actions = isManagerPlus() && a.status === 'PENDING'
      ? `<button class="btn btn-ghost" style="padding:4px 10px;font-size:11px;color:var(--green);border-color:#A7F3D0" onclick="approveAbs('${a.id}')">✓</button>
         <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px;color:var(--red);border-color:#FECACA" onclick="rejectAbsModal('${a.id}')">✕</button>`
      : '';
    return `<tr onmouseover="this.style.background='#FAFBFC'" onmouseout="this.style.background=''">
      <td style="padding:11px 16px">${user}</td>
      <td style="padding:11px 16px">${type}</td>
      <td style="padding:11px 16px">${from}</td>
      <td style="padding:11px 16px">${to}</td>
      <td style="padding:11px 16px">${badge}</td>
      <td style="padding:11px 16px;font-size:12px;color:var(--text-2)">${a.reason || '—'}</td>
      <td style="padding:11px 16px"><div style="display:flex;gap:6px">${actions}</div></td>
    </tr>`;
  }).join('');
}

async function approveAbs(id) {
  try {
    await API.absenceStatus(id, 'APPROVED');
    showToast('Absence approuvée ✓');
    loadAbsences();
  } catch (e) { showToast(e.message, 'error'); }
}

function rejectAbsModal(id) {
  document.getElementById('reject-abs-id').value = id;
  document.getElementById('reject-reason').value = '';
  openModal('modal-reject-abs');
}

async function submitRejectAbs() {
  const id     = document.getElementById('reject-abs-id').value;
  const reason = document.getElementById('reject-reason').value.trim();
  if (!reason) { showToast('Motif requis', 'error'); return; }
  try {
    await API.absenceStatus(id, 'REJECTED', reason);
    closeModal('modal-reject-abs');
    showToast('Absence refusée');
    loadAbsences();
  } catch (e) { showToast(e.message, 'error'); }
}

function setAbsFilter(status, el) {
  _absFilter = status;
  _absPage = 1;
  document.querySelectorAll('#abs-filter-pills .filter-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  loadAbsences();
}

// Declare absence modal
async function openDeclareModal() {
  document.getElementById('dec-start').value = '';
  document.getElementById('dec-end').value   = '';
  document.getElementById('dec-reason').value = '';
  document.getElementById('dec-type').value  = '';
  // populate collab selector for managers
  if (isManagerPlus()) {
    try {
      const users = await API.users({ limit: 100 });
      const sel = document.getElementById('dec-collab');
      sel.innerHTML = '<option value="">Sélectionner…</option>'
        + (users.users || users).map(u => `<option value="${u.id}">${u.firstName} ${u.lastName}</option>`).join('');
      sel.parentElement.style.display = '';
    } catch {}
  } else {
    document.getElementById('dec-collab-wrap').style.display = 'none';
  }
  openModal('modal-declare');
}

async function submitDeclare() {
  const type    = document.getElementById('dec-type').value;
  const start   = document.getElementById('dec-start').value;
  const end     = document.getElementById('dec-end').value;
  const reason  = document.getElementById('dec-reason').value.trim();
  const collabId = document.getElementById('dec-collab')?.value || _user.id;

  if (!type || !start || !end) { showToast('Champs requis', 'error'); return; }
  try {
    await API.createAbsence({ userId: collabId, type, startsAt: start, endsAt: end, reason });
    closeModal('modal-declare');
    showToast('Absence déclarée ✓');
    loadAbsences();
  } catch (e) { showToast(e.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRÉ-PAIE
// ─────────────────────────────────────────────────────────────────────────────
let _ppFilter = 'all';

async function loadPrepaie() {
  document.getElementById('pp-body').innerHTML = '<tr><td colspan="6" class="loading">Chargement…</td></tr>';
  try {
    const params = { page: _ppPage, limit: 20 };
    if (_ppFilter !== 'all') params.status = _ppFilter;
    const [data, summary] = await Promise.all([API.payVars(params), API.payVarSummary()]);
    renderPPSummary(summary);
    renderPPTable(data);
  } catch (e) {
    document.getElementById('pp-body').innerHTML = `<tr><td colspan="6" class="error-msg">${e.message}</td></tr>`;
  }
}

const PP_KIND_FR = { HEURES_SUPP:'H. supplémentaires', PRIME:'Prime', ABSENCE:'Absence', CONGE:'Congé',
  AVANTAGE_NATURE:'Avantage nature', AUTRE:'Autre' };

function renderPPSummary(s) {
  document.getElementById('pp-kpi-pending').textContent  = s.byStatus?.PENDING || 0;
  document.getElementById('pp-kpi-validated').textContent = s.byStatus?.VALIDATED || 0;
  document.getElementById('pp-kpi-anomalies').textContent = s.anomalies || 0;
}

function renderPPTable(data) {
  const vars = data.variables || data;
  if (!vars.length) {
    document.getElementById('pp-body').innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-2)">Aucune variable.</td></tr>';
    return;
  }
  document.getElementById('pp-body').innerHTML = vars.map(v => {
    const user = v.user ? `${v.user.firstName} ${v.user.lastName}` : '—';
    const kind = PP_KIND_FR[v.kind] || v.kind;
    const badge = statusBadge(v.status);
    const val = v.value != null ? `${v.value > 0 ? '+' : ''}${Number(v.value).toFixed(2)}${v.unit || ''}` : '—';
    const actions = isDRHPlus() && v.status === 'PENDING'
      ? `<button class="btn btn-ghost" style="padding:3px 8px;font-size:11px;color:var(--green);border-color:#A7F3D0" onclick="validateVar('${v.id}')">✓</button>
         <button class="btn btn-ghost" style="padding:3px 8px;font-size:11px;color:var(--red);border-color:#FECACA" onclick="rejectVarModal('${v.id}')">✕</button>`
      : '';
    return `<tr onmouseover="this.style.background='#FAFBFC'" onmouseout="this.style.background=''">
      <td style="padding:10px 16px">${user}</td>
      <td style="padding:10px 16px">${kind}</td>
      <td style="padding:10px 16px;font-family:'DM Mono',monospace;font-weight:600">${val}</td>
      <td style="padding:10px 16px;font-size:12px;color:var(--text-2)">${v.label || '—'}</td>
      <td style="padding:10px 16px">${badge}</td>
      <td style="padding:10px 16px"><div style="display:flex;gap:6px">${actions}</div></td>
    </tr>`;
  }).join('');
}

async function validateVar(id) {
  try { await API.validateVar(id); showToast('Variable validée ✓'); loadPrepaie(); }
  catch (e) { showToast(e.message, 'error'); }
}

function rejectVarModal(id) {
  document.getElementById('reject-var-id').value = id;
  document.getElementById('reject-var-reason').value = '';
  openModal('modal-reject-var');
}

async function submitRejectVar() {
  const id     = document.getElementById('reject-var-id').value;
  const reason = document.getElementById('reject-var-reason').value.trim();
  if (!reason) { showToast('Motif requis', 'error'); return; }
  try {
    await API.rejectVar(id, reason);
    closeModal('modal-reject-var');
    showToast('Variable rejetée');
    loadPrepaie();
  } catch (e) { showToast(e.message, 'error'); }
}

async function validateAllPP() {
  const now = new Date();
  try {
    await API.validateAll(now.getFullYear(), now.getMonth() + 1);
    showToast('Toutes les variables validées ✓');
    loadPrepaie();
  } catch (e) { showToast(e.message, 'error'); }
}

async function exportPP() {
  const now = new Date();
  try {
    const blob = await API.exportPay(now.getFullYear(), now.getMonth() + 1);
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `prepaie-${now.getFullYear()}-${now.getMonth()+1}.csv`;
    a.click(); URL.revokeObjectURL(url);
    showToast('Export CSV téléchargé ✓');
  } catch (e) { showToast(e.message, 'error'); }
}

function setPPFilter(status, el) {
  _ppFilter = status;
  _ppPage = 1;
  document.querySelectorAll('#pp-filter-pills .filter-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  loadPrepaie();
}

// ─────────────────────────────────────────────────────────────────────────────
// BIEN-ÊTRE
// ─────────────────────────────────────────────────────────────────────────────
async function loadBienetre() {
  document.getElementById('bienetre-content').innerHTML = '<div class="loading">Chargement…</div>';
  try {
    const [surveys, trends] = await Promise.all([API.surveys(), API.trends(8)]);
    renderBienetre(surveys, trends);
  } catch (e) {
    document.getElementById('bienetre-content').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

function renderBienetre(surveys, trends) {
  const open = surveys.filter(s => s.status === 'OPEN');
  const closed = surveys.filter(s => s.status === 'CLOSED');

  const trendHTML = trends && trends.length
    ? `<div class="card" style="margin-bottom:20px">
        <div class="card-header"><div class="card-title">Tendances bien-être (8 semaines)</div></div>
        <div class="card-body">
          <div class="chart-area">${trends.map(t => {
            const h = Math.round((Number(t.avgScore) || 0) * 14);
            return `<div class="bar-wrap">
              <div class="bar${t.isLatest ? ' highlight' : ''}" style="height:${h}px" title="${Number(t.avgScore||0).toFixed(1)}/10 — S${t.week}"></div>
              <div class="bar-label">S${t.week}</div>
            </div>`;
          }).join('')}</div>
        </div>
      </div>` : '';

  const surveyCards = surveys.map(s => {
    const score = s.avgScore != null ? Number(s.avgScore).toFixed(1) : '—';
    const statusColor = s.status === 'OPEN' ? 'var(--green)' : 'var(--text-2)';
    return `<div class="card" style="margin-bottom:12px">
      <div style="padding:16px 20px;display:flex;align-items:center;justify-content:space-between">
        <div>
          <div style="font-size:14px;font-weight:600">${s.title}</div>
          <div style="font-size:12px;color:var(--text-2);margin-top:2px">${s.responseCount || 0} réponse(s) · Score moyen: ${score}/10</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:11px;font-weight:600;color:${statusColor};background:${s.status === 'OPEN' ? 'var(--green-bg)' : 'var(--bg)'};padding:2px 8px;border-radius:12px">${s.status === 'OPEN' ? 'Ouverte' : 'Fermée'}</span>
          ${s.status === 'OPEN' && !isCollaborateur() ? `<button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="closeSurvey('${s.id}')">Fermer</button>` : ''}
          ${isCollaborateur() && s.status === 'OPEN' ? `<button class="btn btn-primary" style="padding:6px 12px;font-size:12px" onclick="openRespondModal('${s.id}','${s.title}')">Répondre</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('') || '<div style="color:var(--text-2);padding:20px">Aucun sondage créé.</div>';

  document.getElementById('bienetre-content').innerHTML = trendHTML + surveyCards;
}

async function closeSurvey(id) {
  try { await API.closeSurvey(id); showToast('Sondage fermé'); loadBienetre(); }
  catch (e) { showToast(e.message, 'error'); }
}

let _respondSurveyId = null;
async function openRespondModal(id, title) {
  _respondSurveyId = id;
  document.getElementById('respond-title').textContent = title;
  document.getElementById('respond-body').innerHTML = '<div class="loading">Chargement…</div>';
  openModal('modal-respond');
  try {
    const scores = await API.surveyScores(id);
    document.getElementById('respond-body').innerHTML = scores.questions?.map((q, i) =>
      `<div style="margin-bottom:16px">
        <div style="font-size:13px;font-weight:500;margin-bottom:6px">${i+1}. ${q.prompt}</div>
        <div style="display:flex;gap:8px">
          ${[1,2,3,4,5].map(v => `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px">
            <input type="radio" name="q_${q.id}" value="${v}"> ${v}
          </label>`).join('')}
        </div>
      </div>`
    ).join('') || '<div>Aucune question.</div>';
  } catch (e) { document.getElementById('respond-body').innerHTML = `<div class="error-msg">${e.message}</div>`; }
}

async function submitRespond() {
  const inputs = document.querySelectorAll('#respond-body input[type=radio]:checked');
  if (!inputs.length) { showToast('Veuillez répondre à toutes les questions', 'error'); return; }
  const answers = Array.from(inputs).map(i => ({
    questionId: i.name.replace('q_', ''),
    value: parseInt(i.value)
  }));
  try {
    await API.respondSurvey(_respondSurveyId, answers);
    closeModal('modal-respond');
    showToast('Réponse enregistrée ✓');
    loadBienetre();
  } catch (e) { showToast(e.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMUNICATION
// ─────────────────────────────────────────────────────────────────────────────
async function loadComm() {
  try {
    _channels = await API.channels();
    renderChanList();
    if (_channels.length) switchChan(_channels[0].id);
  } catch (e) { showToast(e.message, 'error'); }
}

function renderChanList() {
  document.getElementById('chan-list').innerHTML = _channels.map(ch =>
    `<div class="comm-chan${ch.id === _activeChanId ? ' active' : ''}" onclick="switchChan('${ch.id}')" id="chan-${ch.id}">
      <span class="chan-label"># ${ch.name}</span>
    </div>`
  ).join('');
}

async function switchChan(chanId) {
  _activeChanId = chanId;
  document.querySelectorAll('.comm-chan').forEach(c => c.classList.remove('active'));
  const el = document.getElementById('chan-' + chanId);
  if (el) el.classList.add('active');

  const ch = _channels.find(c => c.id === chanId);
  document.getElementById('chan-name').textContent = ch ? '# ' + ch.name : '';
  document.getElementById('chan-desc').textContent = ch?.description || '';
  document.getElementById('msg-list').innerHTML = '<div class="loading">Chargement…</div>';

  try {
    const data = await API.messages(chanId);
    renderMessages(data.messages || data);
  } catch (e) { document.getElementById('msg-list').innerHTML = `<div class="error-msg">${e.message}</div>`; }
}

function renderMessages(msgs) {
  const el = document.getElementById('msg-list');
  if (!msgs.length) { el.innerHTML = '<div style="padding:16px;color:var(--text-2);font-size:13px">Aucun message.</div>'; return; }
  el.innerHTML = msgs.map(m => {
    const author = m.author ? `${m.author.firstName} ${m.author.lastName}` : '?';
    const init   = author.split(' ').map(x=>x[0]).join('').slice(0,2).toUpperCase();
    const dt     = fmtTime(new Date(m.createdAt));
    const pinned = m.isPinned ? '<span style="font-size:10px;background:var(--blue-light);color:var(--blue);padding:1px 6px;border-radius:10px;margin-left:6px">📌</span>' : '';
    return `<div class="msg-item" data-id="${m.id}">
      <div class="msg-avatar">${init}</div>
      <div class="msg-body">
        <div class="msg-meta"><strong>${author}</strong>${pinned}<span style="font-size:11px;color:var(--text-3);margin-left:8px">${dt}</span></div>
        <div class="msg-text">${escapeHtml(m.content)}</div>
        ${m.edited ? '<div style="font-size:10px;color:var(--text-3);margin-top:2px">(modifié)</div>' : ''}
      </div>
      ${m.author?.id === _user?.id
        ? `<button class="btn btn-ghost" style="padding:2px 8px;font-size:11px;flex-shrink:0;align-self:center" onclick="deleteMsg('${m.id}')">✕</button>`
        : ''}
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function sendMsg() {
  const inp = document.getElementById('msg-input');
  const content = inp.value.trim();
  if (!content || !_activeChanId) return;
  try {
    await API.sendMessage(_activeChanId, content);
    inp.value = '';
    switchChan(_activeChanId);
  } catch (e) { showToast(e.message, 'error'); }
}

async function deleteMsg(id) {
  try { await API.deleteMessage(id); switchChan(_activeChanId); }
  catch (e) { showToast(e.message, 'error'); }
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLABORATEURS
// ─────────────────────────────────────────────────────────────────────────────
async function loadCollabs() {
  document.getElementById('collabs-body').innerHTML = '<tr><td colspan="5" class="loading">Chargement…</td></tr>';
  try {
    const data = await API.users({ limit: 50 });
    renderCollabs(data.users || data);
  } catch (e) {
    document.getElementById('collabs-body').innerHTML = `<tr><td colspan="5" class="error-msg">${e.message}</td></tr>`;
  }
}

const ROLE_COLORS = { COLLABORATEUR:'var(--green)', MANAGER:'var(--orange)', RH:'var(--blue)', DRH:'#7C3AED', ADMIN:'var(--red)' };

function renderCollabs(users) {
  if (!users.length) {
    document.getElementById('collabs-body').innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-2)">Aucun collaborateur.</td></tr>';
    return;
  }
  document.getElementById('collabs-body').innerHTML = users.map(u => {
    const initials = (u.firstName[0] + u.lastName[0]).toUpperCase();
    const color = ROLE_COLORS[u.role] || 'var(--text-2)';
    return `<tr onmouseover="this.style.background='#FAFBFC'" onmouseout="this.style.background=''">
      <td style="padding:12px 16px">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="avatar" style="background:${color}">${initials}</div>
          <div><div style="font-weight:500">${u.firstName} ${u.lastName}</div>
          <div style="font-size:11.5px;color:var(--text-2)">${u.email}</div></div>
        </div>
      </td>
      <td style="padding:12px 16px;font-size:12.5px">${u.jobTitle || '—'}</td>
      <td style="padding:12px 16px"><span style="font-size:11.5px;font-weight:600;color:${color};background:${color}20;padding:2px 8px;border-radius:12px">${u.role}</span></td>
      <td style="padding:12px 16px;font-size:12px;color:var(--text-2)">${u.primarySiteId || '—'}</td>
      <td style="padding:12px 16px"><span style="font-size:11.5px;padding:2px 8px;border-radius:12px;background:${u.isActive ? 'var(--green-bg)' : 'var(--red-bg)'};color:${u.isActive ? 'var(--green)' : 'var(--red)'}">${u.isActive ? 'Actif' : 'Inactif'}</span></td>
    </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLAB HOME
// ─────────────────────────────────────────────────────────────────────────────
async function loadCollabHome() {
  try {
    const data = await API.absences({ userId: _user.id, limit: 5 });
    const abs = data.absences || data;
    document.getElementById('my-abs-list').innerHTML = abs.length
      ? abs.map(a => `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:13px;font-weight:500">${ABS_TYPE_FR[a.type] || a.type}</div>
            <div style="font-size:11.5px;color:var(--text-2)">${fmtDate(a.startsAt)} → ${fmtDate(a.endsAt)}</div>
          </div>
          ${statusBadge(a.status)}
        </div>`).join('')
      : '<div style="color:var(--text-2);font-size:13px;padding:10px 0">Aucune absence.</div>';
  } catch {}
}

async function loadMonPlanning() {
  document.getElementById('my-plan-body').innerHTML = '<div class="loading">Chargement…</div>';
  try {
    const data = await API.planningWeek();
    const myShifts = [];
    data.users?.forEach(u => {
      if (u.id === _user.id) {
        u.shifts.forEach(s => myShifts.push({...s, ...data.days[s.dayIndex]}));
      }
    });
    document.getElementById('my-plan-body').innerHTML = myShifts.length
      ? myShifts.map(s => `<div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div style="font-size:13px;font-weight:500">${s.label || ''}</div>
          <div style="font-size:12px;color:var(--text-2)">${fmtShiftLabel(s)}</div>
        </div>`).join('')
      : '<div style="color:var(--text-2);font-size:13px;padding:16px 0">Aucun shift cette semaine.</div>';
  } catch (e) {
    document.getElementById('my-plan-body').innerHTML = `<div class="error-msg">${e.message}</div>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function statusBadge(s) {
  const map = {
    PENDING:   ['#FFF7ED','#D97706','En attente'],
    APPROVED:  ['#ECFDF5','#059669','Approuvée'],
    REJECTED:  ['#FEF2F2','#DC2626','Refusée'],
    DRAFT:     ['#F3F4F6','#6B7280','Brouillon'],
    VALIDATED: ['#ECFDF5','#059669','Validée'],
    OPEN:      ['#EFF6FF','#2563EB','Ouverte'],
    CLOSED:    ['#F3F4F6','#6B7280','Fermée'],
  };
  const [bg, color, label] = map[s] || ['#F3F4F6','#6B7280', s];
  return `<span style="font-size:11px;font-weight:600;background:${bg};color:${color};padding:2px 8px;border-radius:12px;white-space:nowrap">${label}</span>`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function fmtTime(d) {
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function fmtAgo(d) {
  const diff = Math.round((Date.now() - d) / 1000);
  if (diff < 60) return 'à l\'instant';
  if (diff < 3600) return `il y a ${Math.floor(diff/60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff/3600)}h`;
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', initApp);
