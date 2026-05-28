// pages-api.js — Connexion des pages statiques ↔ API backend
(function () {
  'use strict';

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function scoreColor(s) {
    if (s == null) return 'var(--text-3)';
    if (s >= 7.5) return 'var(--green)';
    if (s >= 5) return 'var(--orange)';
    return 'var(--red)';
  }

  /* ─── Collaborateurs ─────────────────────────────────────── */

  const COLLAB_USER_ROLES = [
    { value: 'COLLABORATEUR', label: 'Collaborateur' },
    { value: 'MANAGER', label: 'Manager' },
    { value: 'RH', label: 'RH' },
    { value: 'DRH', label: 'DRH' },
    { value: 'ADMIN', label: 'Admin' },
  ];
  const COLLAB_CONTRACTS = [
    { value: 'CDI', label: 'CDI' },
    { value: 'CDD', label: 'CDD' },
    { value: 'INTERIM', label: 'Intérim' },
  ];
  const COLLAB_HOUR_PRESETS = [
    { hours: 35, label: '35h — Temps plein (légal)' },
    { hours: 39, label: '39h — Temps plein CHR' },
    { hours: 28, label: '28h — Temps partiel' },
    { hours: 24, label: '24h — Mi-temps' },
    { hours: 20, label: '20h — Mi-temps réduit' },
    { hours: 'custom', label: 'Autre volume…' },
  ];

  let collabCompanyRules = null;

  async function ensureCollabCompanyRules() {
    if (collabCompanyRules || typeof api.companySettings !== 'function') return collabCompanyRules;
    try {
      const data = await api.companySettings();
      collabCompanyRules = data?.settings?.planningRules || {};
      window._companyPlanningRules = collabCompanyRules;
    } catch (_e) { collabCompanyRules = {}; }
    return collabCompanyRules;
  }

  function collabComputeLimitsLocal(weeklyHours, contractType) {
    const rules = collabCompanyRules || window._companyPlanningRules || {};
    const legal = rules.legalWeeklyHours || 35;
    const maxLegal = rules.maxWeeklyHours || 48;
    const contract = weeklyHours != null && weeklyHours > 0 ? Number(weeklyHours) : legal;
    const isPartTime = contract < legal;
    let maxPlanning = maxLegal;
    if (isPartTime) maxPlanning = Math.min(maxLegal, Math.round(contract * 1.33 * 10) / 10);
    else if (contractType === 'INTERIM') maxPlanning = Math.min(maxLegal, contract);
    return {
      contractWeeklyHours: contract,
      maxWeeklyHoursLegal: maxLegal,
      maxWeeklyHoursPlanning: maxPlanning,
      isPartTime: isPartTime,
    };
  }

  function collabHoursSummaryHtml(weeklyHours, contractType, limitsFromApi) {
    const lim = limitsFromApi || collabComputeLimitsLocal(weeklyHours, contractType);
    const contract = weeklyHours != null ? weeklyHours + 'h/sem.' : '—';
    const maxTxt = lim.maxWeeklyHoursPlanning != null
      ? ` · max planifiable ${lim.maxWeeklyHoursPlanning}h`
      : '';
    const legalTxt = lim.maxWeeklyHoursLegal != null
      ? ` (plafond légal ${lim.maxWeeklyHoursLegal}h)`
      : '';
    return { contract, maxTxt, legalTxt, lim };
  }

  function collabFormatHourlyRate(rate) {
    if (rate == null || Number.isNaN(rate)) return '—';
    return Number(rate).toFixed(2).replace('.', ',') + ' €/h';
  }

  function collabReadHourlyRate(prefix) {
    if (!collabCanEditHourlyRate()) return undefined;
    const raw = document.querySelector('.' + prefix + '-hourly-rate')?.value;
    if (raw === '' || raw == null) return null;
    const val = parseFloat(String(raw).replace(',', '.'));
    return Number.isNaN(val) ? null : val;
  }

  function collabCanEditHourlyRate() {
    const role = window.Auth?.user?.role || window.currentUser?.role;
    return role === 'RH' || role === 'DRH' || role === 'ADMIN';
  }

  function renderCollabHourlyRateField(prefix, user) {
    const u = user || {};
    const rateLabel = collabFormatHourlyRate(u.hourlyRate);
    if (collabCanEditHourlyRate()) {
      return `<div class="form-group" style="grid-column:1/-1;margin-top:4px;padding-top:14px;border-top:1px dashed var(--border)">
        <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:10px">Rémunération <span style="font-weight:500;color:var(--text-3)">· modifiable RH</span></div>
        <label class="form-label">Taux horaire brut (€/h)</label>
        <input class="form-input ${prefix}-hourly-rate" type="number" min="0" max="999" step="0.01" value="${u.hourlyRate != null ? u.hourlyRate : ''}" placeholder="Ex. 11,65">
        <div style="font-size:11px;color:var(--text-3);margin-top:6px;line-height:1.45">Utilisé pour l'estimation salaire collaborateur et la pré-paie. Laisser vide pour appliquer le taux société par défaut.</div>
      </div>`;
    }
    return `<div class="form-group" style="grid-column:1/-1;margin-top:4px;padding-top:14px;border-top:1px dashed var(--border)">
      <div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:10px">Rémunération</div>
      <label class="form-label">Taux horaire brut (€/h)</label>
      <div class="form-input" style="background:var(--bg);cursor:default;color:var(--text-2)">${rateLabel}</div>
      <div style="font-size:11px;color:var(--text-3);margin-top:6px">Modification réservée aux profils RH (DRH, Admin).</div>
    </div>`;
  }

  function collabMatchHourPreset(hours) {
    if (hours == null) return 'custom';
    const match = COLLAB_HOUR_PRESETS.find(function (p) { return p.hours === hours; });
    return match ? match.hours : 'custom';
  }

  window.collabHoursPresetChange = function collabHoursPresetChange(prefix) {
    const sel = document.querySelector('.' + prefix + '-hours-preset');
    const input = document.querySelector('.' + prefix + '-hours');
    const customWrap = document.querySelector('.' + prefix + '-hours-custom-wrap');
    if (!sel || !input) return;
    if (sel.value === 'custom') {
      if (customWrap) customWrap.style.display = '';
      input.focus();
    } else {
      input.value = sel.value;
      if (customWrap) customWrap.style.display = 'none';
    }
    collabUpdateHoursLimits(prefix);
  };

  window.collabUpdateHoursLimits = function collabUpdateHoursLimits(prefix) {
    const input = document.querySelector('.' + prefix + '-hours');
    const contractSel = document.querySelector('.' + prefix + '-contract');
    const info = document.querySelector('.' + prefix + '-hours-info');
    if (!info) return;
    const hours = input?.value ? parseFloat(input.value) : null;
    const lim = collabComputeLimitsLocal(hours, contractSel?.value);
    const partTimeNote = lim.isPartTime ? ' · temps partiel' : '';
    info.innerHTML = hours
      ? `Contrat <strong>${hours}h</strong>/sem. · max planifiable <strong>${lim.maxWeeklyHoursPlanning}h</strong>${partTimeNote} · plafond légal ${lim.maxWeeklyHoursLegal}h`
      : 'Saisissez le volume horaire contractuel — le maximum planifiable sera calculé selon le Code du travail.';
  };

  let collabFilters = { search: '', contractTypes: [], siteIds: [], includeInactive: false };
  let collabPagination = { page: 1, limit: 24, total: 0, totalPages: 1, sort: 'lastName', order: 'asc' };
  let collabSitesCache = [];
  let collabUsersCache = [];
  let collabJobPositionsCache = [];
  let collabPolesCache = [];
  let collabSkillsCache = [];
  let collabManagersCache = [];
  let collabCurrentUser = null;
  let collabEditMode = false;
  let collabSearchTimer = null;
  let collabListCache = null;
  let collabListFetchKey = '';
  let collabListFetchPromise = null;
  const COLLAB_LIST_CACHE_MS = 25000;

  function collabPoleNames(user) {
    const names = new Set(collabPolesCache.map(function (p) { return p.name; }));
    (user?.secondaryRoles || []).forEach(function (n) { if (n) names.add(n); });
    return Array.from(names).sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  }

  function collabJobTitleOptions(user) {
    const names = new Set(collabJobPositionsCache.map(function (p) { return p.name; }));
    if (user?.jobTitle) names.add(user.jobTitle);
    return Array.from(names).sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  }

  async function loadCollabCatalog() {
    if (typeof api.userCatalog !== 'function') return;
    try {
      const catalog = await api.userCatalog();
      collabJobPositionsCache = catalog.jobPositions || [];
      collabPolesCache = catalog.operationalPoles || [];
      collabSkillsCache = catalog.skills || [];
    } catch (_e) { /* optional */ }
  }

  function collabSkillNames(user) {
    const names = new Set(collabSkillsCache.map(function (s) { return s.name; }));
    (user?.competences || []).forEach(function (n) { if (n) names.add(n); });
    return Array.from(names).sort(function (a, b) { return a.localeCompare(b, 'fr'); });
  }

  function invalidateCollabCaches() {
    collabManagersCache = [];
    invalidateCollabListCache();
    if (typeof planCollabsLoaded !== 'undefined') planCollabsLoaded = false;
    if (typeof invalidatePlanningCache === 'function') invalidatePlanningCache();
  }

  async function ensureCollabManagersCache(force) {
    if (!force && collabManagersCache.length) return;
    collabManagersCache = [];
    try {
      const res = await api.users({ limit: 200, sort: 'lastName' });
      collabManagersCache = (res.users || []).filter(function (u) { return u.isActive !== false; });
    } catch (_e) { /* optional */ }
  }

  function collabManagerOptions(user) {
    const roles = ['MANAGER', 'RH', 'DRH', 'ADMIN'];
    const map = new Map();
    collabManagersCache.concat(collabUsersCache).forEach(function (u) {
      if (u.isActive === false) return;
      if (roles.indexOf(u.role) >= 0 && u.id !== (user?.id)) map.set(u.id, u);
    });
    return Array.from(map.values()).sort(function (a, b) { return a.lastName.localeCompare(b.lastName, 'fr'); });
  }

  function collabContractNeedsEndDate(type) {
    return type === 'CDD' || type === 'INTERIM';
  }

  function renderCollabFormFields(prefix, user, sites) {
    const u = user || {};
    const siteOpts = (sites || collabSitesCache).map(function (s) {
      const sel = u.siteId === s.id ? ' selected' : '';
      return `<option value="${esc(s.id)}"${sel}>${esc(s.name)}</option>`;
    }).join('');
    const roleOpts = COLLAB_USER_ROLES.map(function (r) {
      return `<option value="${r.value}"${u.role === r.value ? ' selected' : ''}>${r.label}</option>`;
    }).join('');
    const contractOpts = COLLAB_CONTRACTS.map(function (c) {
      return `<option value="${c.value}"${u.contractType === c.value ? ' selected' : ''}>${c.label}</option>`;
    }).join('');
    const jobOpts = collabJobTitleOptions(u).map(function (name) {
      const sel = u.jobTitle === name ? ' selected' : '';
      return `<option value="${esc(name)}"${sel}>${esc(name)}</option>`;
    }).join('');
    const poleNames = collabPoleNames(u);
    const poleChecks = poleNames.map(function (p) {
      const checked = (u.secondaryRoles || []).includes(p) ? ' checked' : '';
      return `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:0 10px 6px 0;cursor:pointer"><input type="checkbox" class="${prefix}-pole" value="${esc(p)}"${checked}> ${esc(p)}</label>`;
    }).join('');
    const comps = (u.competences || []).join(', ');
    const skillNames = collabSkillNames(u);
    const skillChecks = skillNames.map(function (s) {
      const checked = (u.competences || []).includes(s) ? ' checked' : '';
      return `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin:0 10px 6px 0;cursor:pointer"><input type="checkbox" class="${prefix}-skill" value="${esc(s)}"${checked}> ${esc(s)}</label>`;
    }).join('');
    const managerOpts = collabManagerOptions(u).map(function (m) {
      const sel = u.managerId === m.id ? ' selected' : '';
      return `<option value="${esc(m.id)}"${sel}>${esc(m.shortName)} — ${esc(m.jobTitle || m.role)}</option>`;
    }).join('');
    const endDate = u.contractEndDate || '';
    const showEnd = collabContractNeedsEndDate(u.contractType);
    const jobInCatalog = u.jobTitle && collabJobPositionsCache.some(function (p) { return p.name === u.jobTitle; });
    const useCustomJob = u.jobTitle && !jobInCatalog;
    const hourPreset = collabMatchHourPreset(u.weeklyHours);
    const presetOpts = COLLAB_HOUR_PRESETS.map(function (p) {
      const val = String(p.hours);
      const sel = String(hourPreset) === val ? ' selected' : '';
      return `<option value="${val}"${sel}>${esc(p.label)}</option>`;
    }).join('');

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div class="form-group"><label class="form-label">Prénom *</label><input class="form-input ${prefix}-fn" value="${esc(u.firstName || '')}"></div>
        <div class="form-group"><label class="form-label">Nom *</label><input class="form-input ${prefix}-ln" value="${esc(u.lastName || '')}"></div>
        <div class="form-group" style="grid-column:1/-1"><label class="form-label">E-mail *</label><input class="form-input ${prefix}-email" type="email" value="${esc(u.email || '')}"></div>
        <div class="form-group">
          <label class="form-label">Poste</label>
          <select class="form-input ${prefix}-job-select" onchange="collabJobSelectChange('${prefix}')">
            <option value="">— Choisir un poste —</option>
            ${jobOpts}
            <option value="__custom__"${useCustomJob ? ' selected' : ''}>✏️ Autre (saisie libre)</option>
          </select>
          <input class="form-input ${prefix}-job-custom" style="margin-top:8px;${useCustomJob ? '' : 'display:none'}" value="${esc(useCustomJob ? u.jobTitle : '')}" placeholder="Nom du poste personnalisé">
        </div>
        <div class="form-group"><label class="form-label">Établissement</label><select class="form-input ${prefix}-site"><option value="">—</option>${siteOpts}</select></div>
        <div class="form-group"><label class="form-label">Rôle applicatif</label><select class="form-input ${prefix}-role">${roleOpts}</select></div>
        <div class="form-group"><label class="form-label">Contrat</label><select class="form-input ${prefix}-contract" onchange="collabContractChange('${prefix}');collabUpdateHoursLimits('${prefix}')">${contractOpts}</select></div>
        <div class="form-group ${prefix}-end-wrap" style="${showEnd ? '' : 'display:none'}"><label class="form-label">Fin de contrat</label><input class="form-input ${prefix}-end" type="date" value="${esc(endDate)}"></div>
        <div class="form-group"><label class="form-label">Manager</label><select class="form-input ${prefix}-manager"><option value="">— Aucun —</option>${managerOpts}</select></div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="form-label">Contrat horaire</label>
          <select class="form-input ${prefix}-hours-preset" onchange="collabHoursPresetChange('${prefix}')" style="margin-bottom:8px">${presetOpts}</select>
          <div class="${prefix}-hours-custom-wrap" style="${hourPreset === 'custom' ? '' : 'display:none'}">
            <input class="form-input ${prefix}-hours" type="number" min="0" max="80" step="0.5" value="${u.weeklyHours != null ? u.weeklyHours : ''}" placeholder="38" oninput="collabUpdateHoursLimits('${prefix}')">
          </div>
          <div class="${prefix}-hours-info" style="font-size:11.5px;color:var(--text-3);margin-top:6px;line-height:1.45"></div>
        </div>
        <div class="form-group"><label class="form-label">Téléphone</label><input class="form-input ${prefix}-phone" value="${esc(u.phone || '')}"></div>
        ${renderCollabHourlyRateField(prefix, u)}
      </div>
      <div class="form-group" style="margin-top:4px">
        <label class="form-label">Pôles / rôles opérationnels</label>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px"><a href="#" onclick="event.preventDefault();openCollabCatalogModal()" style="color:var(--blue)">+ Créer un pôle personnalisé</a></div>
        <div style="display:flex;flex-wrap:wrap;margin-top:4px">${poleChecks || '<span style="font-size:12px;color:var(--text-3)">Aucun pôle — créez-en via « Postes & pôles »</span>'}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Compétences catalogue</label>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px"><a href="#" onclick="event.preventDefault();openCollabCatalogModal()" style="color:var(--blue)">+ Gérer le catalogue compétences</a></div>
        <div style="display:flex;flex-wrap:wrap;margin-top:4px">${skillChecks || '<span style="font-size:12px;color:var(--text-3)">Aucune — créez-en via « Postes & pôles »</span>'}</div>
      </div>
      <div class="form-group">
        <label class="form-label">Compétences libres <span style="font-weight:400;color:var(--text-3)">(virgules)</span></label>
        <input class="form-input ${prefix}-comps-extra" value="${esc(comps)}" placeholder="Autres compétences…">
      </div>`;
  }

  function collabContractChange(prefix) {
    const sel = document.querySelector('.' + prefix + '-contract');
    const wrap = document.querySelector('.' + prefix + '-end-wrap');
    if (!sel || !wrap) return;
    wrap.style.display = collabContractNeedsEndDate(sel.value) ? '' : 'none';
  }

  function collabJobSelectChange(prefix) {
    const sel = document.querySelector('.' + prefix + '-job-select');
    const custom = document.querySelector('.' + prefix + '-job-custom');
    if (!sel || !custom) return;
    if (sel.value === '__custom__') {
      custom.style.display = '';
      custom.focus();
    } else {
      custom.style.display = 'none';
      custom.value = sel.value || '';
    }
  }

  function readCollabJobTitle(prefix) {
    const sel = document.querySelector('.' + prefix + '-job-select');
    const custom = document.querySelector('.' + prefix + '-job-custom');
    if (sel?.value === '__custom__') {
      return custom?.value.trim() || null;
    }
    return sel?.value?.trim() || custom?.value?.trim() || null;
  }

  function collabChipHtml(items, color) {
    if (!items || !items.length) {
      return '<span style="color:var(--text-3);font-size:12px">Aucune</span>';
    }
    return items.map(function (t) {
      return `<span style="display:inline-flex;align-items:center;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;background:${color || 'var(--blue-light)'};color:${color ? 'white' : 'var(--blue)'};margin:2px 4px 2px 0">${esc(t)}</span>`;
    }).join('');
  }

  function renderCollabCatalogBody() {
    const postes = collabJobPositionsCache.map(function (p) {
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
        <span style="font-size:13px">${esc(p.name)}</span>
        <button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px;color:var(--red)" onclick="deleteCollabJobPosition('${esc(p.id)}')">Supprimer</button>
      </div>`;
    }).join('') || '<div style="font-size:12px;color:var(--text-3);padding:8px 0">Aucun poste</div>';

    const poles = collabPolesCache.map(function (p) {
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
        <span style="font-size:13px">${esc(p.name)}</span>
        <button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px;color:var(--red)" onclick="deleteCollabPole('${esc(p.id)}')">Supprimer</button>
      </div>`;
    }).join('') || '<div style="font-size:12px;color:var(--text-3);padding:8px 0">Aucun pôle</div>';

    const skills = collabSkillsCache.map(function (s) {
      return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
        <span style="font-size:13px">${esc(s.name)}</span>
        <button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px;color:var(--red)" onclick="deleteCollabSkill('${esc(s.id)}')">Supprimer</button>
      </div>`;
    }).join('') || '<div style="font-size:12px;color:var(--text-3);padding:8px 0">Aucune compétence</div>';

    return `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
        <div>
          <div style="font-weight:700;font-size:13px;margin-bottom:10px">Postes</div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input id="catalog-new-poste" class="form-input" placeholder="Ex. Chef de partie" style="flex:1">
            <button type="button" class="btn btn-primary" onclick="addCollabJobPosition()">Ajouter</button>
          </div>
          <div style="max-height:240px;overflow-y:auto">${postes}</div>
        </div>
        <div>
          <div style="font-weight:700;font-size:13px;margin-bottom:10px">Pôles opérationnels</div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input id="catalog-new-pole" class="form-input" placeholder="Ex. Pâtisserie" style="flex:1">
            <button type="button" class="btn btn-primary" onclick="addCollabPole()">Ajouter</button>
          </div>
          <div style="max-height:240px;overflow-y:auto">${poles}</div>
        </div>
        <div>
          <div style="font-weight:700;font-size:13px;margin-bottom:10px">Compétences</div>
          <div style="display:flex;gap:8px;margin-bottom:12px">
            <input id="catalog-new-skill" class="form-input" placeholder="Ex. Sommelier" style="flex:1">
            <button type="button" class="btn btn-primary" onclick="addCollabSkill()">Ajouter</button>
          </div>
          <div style="max-height:240px;overflow-y:auto">${skills}</div>
        </div>
        <div style="grid-column:1/-1;border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
          <div style="font-weight:700;font-size:13px;margin-bottom:10px">Établissements</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">
            <input id="catalog-new-site" class="form-input" placeholder="Nom établissement" style="flex:1;min-width:160px">
            <input id="catalog-new-site-city" class="form-input" placeholder="Ville" style="width:120px">
            <button type="button" class="btn btn-primary" onclick="addCollabSite()">Ajouter</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${(collabSitesCache || []).map(function (s) {
            return `<span style="font-size:12px;padding:4px 10px;border-radius:999px;background:var(--bg);border:1px solid var(--border)">${esc(s.name)}${s.city ? ' · ' + esc(s.city) : ''}</span>`;
          }).join('') || '<span style="font-size:12px;color:var(--text-3)">Aucun</span>'}</div>
        </div>
      </div>`;
  }

  async function openCollabCatalogModal() {
    document.getElementById('collab-catalog-body').innerHTML = '<div style="padding:24px;color:var(--text-3);font-size:13px">Chargement du catalogue…</div>';
    document.getElementById('modal-collab-catalog').classList.add('open');
    await loadCollabCatalog();
    const body = document.getElementById('collab-catalog-body');
    if (body) body.innerHTML = renderCollabCatalogBody();
  }

  async function addCollabJobPosition() {
    const input = document.getElementById('catalog-new-poste');
    const name = input?.value.trim();
    if (!name) {
      if (typeof showToast === 'function') showToast('Saisissez un nom de poste.');
      return;
    }
    try {
      const res = await api.createJobPosition(name);
      collabJobPositionsCache.push(res.jobPosition);
      collabJobPositionsCache.sort(function (a, b) { return a.name.localeCompare(b.name, 'fr'); });
      if (input) input.value = '';
      document.getElementById('collab-catalog-body').innerHTML = renderCollabCatalogBody();
      if (typeof showToast === 'function') showToast('Poste « ' + name + ' » créé');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  async function addCollabPole() {
    const input = document.getElementById('catalog-new-pole');
    const name = input?.value.trim();
    if (!name) {
      if (typeof showToast === 'function') showToast('Saisissez un nom de pôle.');
      return;
    }
    try {
      const res = await api.createOperationalPole(name);
      collabPolesCache.push(res.operationalPole);
      collabPolesCache.sort(function (a, b) { return a.name.localeCompare(b.name, 'fr'); });
      if (input) input.value = '';
      document.getElementById('collab-catalog-body').innerHTML = renderCollabCatalogBody();
      if (typeof showToast === 'function') showToast('Pôle « ' + name + ' » créé');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  async function deleteCollabJobPosition(id) {
    if (!confirm('Supprimer ce poste du catalogue ?')) return;
    try {
      await api.deleteJobPosition(id);
      collabJobPositionsCache = collabJobPositionsCache.filter(function (p) { return p.id !== id; });
      document.getElementById('collab-catalog-body').innerHTML = renderCollabCatalogBody();
      if (typeof showToast === 'function') showToast('Poste supprimé');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  async function deleteCollabPole(id) {
    if (!confirm('Supprimer ce pôle du catalogue ?')) return;
    try {
      await api.deleteOperationalPole(id);
      collabPolesCache = collabPolesCache.filter(function (p) { return p.id !== id; });
      document.getElementById('collab-catalog-body').innerHTML = renderCollabCatalogBody();
      if (typeof showToast === 'function') showToast('Pôle supprimé');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  async function addCollabSkill() {
    const input = document.getElementById('catalog-new-skill');
    const name = input?.value.trim();
    if (!name) {
      if (typeof showToast === 'function') showToast('Saisissez une compétence.');
      return;
    }
    try {
      const res = await api.createSkill(name);
      collabSkillsCache.push(res.skill);
      collabSkillsCache.sort(function (a, b) { return a.name.localeCompare(b.name, 'fr'); });
      if (input) input.value = '';
      document.getElementById('collab-catalog-body').innerHTML = renderCollabCatalogBody();
      if (typeof showToast === 'function') showToast('Compétence « ' + name + ' » créée');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  async function deleteCollabSkill(id) {
    if (!confirm('Supprimer cette compétence du catalogue ?')) return;
    try {
      await api.deleteSkill(id);
      collabSkillsCache = collabSkillsCache.filter(function (s) { return s.id !== id; });
      document.getElementById('collab-catalog-body').innerHTML = renderCollabCatalogBody();
      if (typeof showToast === 'function') showToast('Compétence supprimée');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  async function addCollabSite() {
    const nameIn = document.getElementById('catalog-new-site');
    const cityIn = document.getElementById('catalog-new-site-city');
    const name = nameIn?.value.trim();
    if (!name) {
      if (typeof showToast === 'function') showToast('Saisissez un nom d\'établissement.');
      return;
    }
    try {
      const res = await api.createSite({ name, city: cityIn?.value.trim() || undefined });
      collabSitesCache.push(res.site);
      collabSitesCache.sort(function (a, b) { return a.name.localeCompare(b.name, 'fr'); });
      if (nameIn) nameIn.value = '';
      if (cityIn) cityIn.value = '';
      renderCollabFilterSelect();
      document.getElementById('collab-catalog-body').innerHTML = renderCollabCatalogBody();
      if (typeof showToast === 'function') showToast('Établissement « ' + name + ' » créé');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  function readCollabForm(prefix) {
    const poles = [];
    document.querySelectorAll('.' + prefix + '-pole:checked').forEach(function (el) {
      poles.push(el.value);
    });
    const skills = [];
    document.querySelectorAll('.' + prefix + '-skill:checked').forEach(function (el) {
      skills.push(el.value);
    });
    const extraRaw = document.querySelector('.' + prefix + '-comps-extra')?.value || '';
    const extra = extraRaw.split(/[,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    const competences = [...new Set(skills.concat(extra))];
    const hoursVal = (function () {
      const preset = document.querySelector('.' + prefix + '-hours-preset')?.value;
      if (preset && preset !== 'custom') return preset;
      return document.querySelector('.' + prefix + '-hours')?.value;
    })();
    const contractType = document.querySelector('.' + prefix + '-contract')?.value;
    const endVal = document.querySelector('.' + prefix + '-end')?.value;
    const managerId = document.querySelector('.' + prefix + '-manager')?.value || null;
    const payload = {
      firstName: document.querySelector('.' + prefix + '-fn')?.value.trim(),
      lastName: document.querySelector('.' + prefix + '-ln')?.value.trim(),
      email: document.querySelector('.' + prefix + '-email')?.value.trim(),
      jobTitle: readCollabJobTitle(prefix),
      siteId: document.querySelector('.' + prefix + '-site')?.value || null,
      role: document.querySelector('.' + prefix + '-role')?.value,
      contractType: contractType,
      contractEndDate: collabContractNeedsEndDate(contractType) && endVal ? endVal : null,
      weeklyHours: hoursVal ? parseFloat(hoursVal) : null,
      phone: document.querySelector('.' + prefix + '-phone')?.value.trim() || null,
      managerId: managerId,
      secondaryRoles: poles,
      competences: competences,
    };
    const hourlyRate = collabReadHourlyRate(prefix);
    if (hourlyRate !== undefined) payload.hourlyRate = hourlyRate;
    return payload;
  }

  function collabAvatarEl(u) {
    if (u.avatarUrl) {
      return `<div class="collab-avatar" data-avatar-url="${esc(u.avatarUrl)}" style="background:${esc(u.avatarColor || '#6B7280')};background-size:cover;background-position:center;overflow:hidden">${esc(u.initials)}</div>`;
    }
    return `<div class="collab-avatar" style="background:${esc(u.avatarColor)}">${esc(u.initials)}</div>`;
  }

  function hydrateCollabAvatars(root) {
    if (!root || typeof Auth === 'undefined' || !Auth.accessToken) return;
    var pending = Array.from(root.querySelectorAll('.collab-avatar[data-avatar-url]')).filter(function (el) {
      return el.getAttribute('data-avatar-url') && !el.dataset.avatarLoaded;
    });
    var idx = 0;
    var concurrency = 4;
    function pump() {
      while (idx < pending.length && concurrency > 0) {
        var el = pending[idx++];
        concurrency--;
        el.dataset.avatarLoaded = '1';
        var url = el.getAttribute('data-avatar-url');
        fetch(url, { headers: { Authorization: 'Bearer ' + Auth.accessToken } })
          .then(function (r) { return r.ok ? r.blob() : null; })
          .then(function (b) {
            if (b) {
              el.style.backgroundImage = 'url(' + URL.createObjectURL(b) + ')';
              el.style.color = 'transparent';
            }
          }).catch(function () { /* fallback initials */ })
          .finally(function () { concurrency++; pump(); });
      }
    }
    pump();
  }

  function renderCollabCard(u) {
    const abs = u.pendingAbsence
      ? `<div class="collab-meta-item"><div class="collab-meta-label">Statut</div><div class="collab-meta-val" style="color:var(--red)">Absent · ${esc(u.pendingAbsence.type)}</div></div>`
      : '';
    const anom = u.payAnomaly
      ? `<div class="collab-meta-item"><div class="collab-meta-label">Anomalie paie</div><div class="collab-meta-val" style="color:var(--red)">⚠ ${esc(u.payAnomalyType || 'Anomalie')}</div></div>`
      : '';
    const comps = (u.competences || []).slice(0, 3);
    const compsMore = (u.competences || []).length > 3 ? ` +${u.competences.length - 3}` : '';
    const compsHtml = comps.length
      ? `<div class="collab-meta-item" style="grid-column:1/-1"><div class="collab-meta-label">Compétences</div><div class="collab-meta-val">${collabChipHtml(comps)}${compsMore ? `<span style="font-size:11px;color:var(--text-3)">${compsMore}</span>` : ''}</div></div>`
      : '';
    const polesHtml = (u.secondaryRoles || []).length
      ? `<div class="collab-meta-item"><div class="collab-meta-label">Pôles</div><div class="collab-meta-val">${collabChipHtml(u.secondaryRoles, '#6366F1')}</div></div>`
      : '';
    const hoursInfo = collabHoursSummaryHtml(u.weeklyHours, u.contractType, u);
    const hours = u.weeklyHours != null
      ? `${u.weeklyHours}h/sem.${hoursInfo.maxTxt}`
      : '—';

    return `<div class="collab-card${u.isActive === false ? ' collab-inactive' : ''}" onclick="openCollabModal('${esc(u.id)}')" data-user-id="${esc(u.id)}" style="${u.isActive === false ? 'opacity:.65' : ''}">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        ${collabAvatarEl(u)}
        <div style="flex:1"><div class="collab-name">${esc(u.shortName)}</div><div class="collab-role">${esc(u.jobTitle || u.role)} · ${esc(u.siteName || '—')}</div></div>
        <span class="contract-badge ${esc(u.contractBadgeClass || 'cdi')}">${esc(u.contractLabel || 'CDI')}</span>
      </div>
      <div class="collab-meta">
        <div class="collab-meta-item"><div class="collab-meta-label">Rôle</div><div class="collab-meta-val">${esc(u.role)}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Email</div><div class="collab-meta-val" style="font-size:11px">${esc(u.email)}</div></div>
        ${polesHtml}
        <div class="collab-meta-item"><div class="collab-meta-label">Volume horaire</div><div class="collab-meta-val">${hours}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Taux horaire</div><div class="collab-meta-val">${collabFormatHourlyRate(u.hourlyRate)}</div></div>
        ${compsHtml}${abs}${anom}
      </div>
    </div>`;
  }

  function collabBuildApiFilters() {
    const f = {
      page: collabPagination.page,
      limit: collabPagination.limit,
      sort: collabPagination.sort,
      order: collabPagination.order,
    };
    if (collabFilters.search) f.search = collabFilters.search;
    if (collabFilters.contractTypes.length) f.contractTypes = collabFilters.contractTypes.join(',');
    if (collabFilters.siteIds.length) f.siteIds = collabFilters.siteIds.join(',');
    if (collabFilters.includeInactive) f.includeInactive = 'true';
    const hasCatalog = collabJobPositionsCache.length && collabPolesCache.length && collabSkillsCache.length;
    if (hasCatalog) f.includeCatalog = 'false';
    return f;
  }

  function collabListCacheKey() {
    return JSON.stringify(collabBuildApiFilters());
  }

  function invalidateCollabListCache() {
    collabListCache = null;
    collabListFetchKey = '';
  }

  function applyCollaborateursPageData(data) {
    const page = document.getElementById('page-collaborateurs');
    if (!page) return;
    const grid = page.querySelector('.collab-grid');
    const subtitle = page.querySelector('.section-header p');
    if (!grid) return;

    const users = data.users || [];
    const stats = data.stats || {};
    collabUsersCache = users;
    if (data.sites) collabSitesCache = data.sites;
    if (data.catalog) {
      collabJobPositionsCache = data.catalog.jobPositions || [];
      collabPolesCache = data.catalog.operationalPoles || [];
      collabSkillsCache = data.catalog.skills || [];
    }
    if (data.pagination) {
      collabPagination = Object.assign(collabPagination, data.pagination);
    } else if (data.stats) {
      collabPagination.total = data.stats.total;
      collabPagination.totalPages = Math.max(1, Math.ceil(data.stats.total / collabPagination.limit));
    }

    renderCollabFilterSelect();
    renderCollabPaginationBar();
    updateCollabResendAllButton();

    if (subtitle) {
      subtitle.textContent = `${collabPagination.total} salarié${collabPagination.total > 1 ? 's' : ''} · ${stats.sites} établissement${stats.sites > 1 ? 's' : ''} · Données live`;
    }

    if (!users.length) {
      grid.innerHTML = '<div style="padding:48px;text-align:center;color:var(--text-3)">Aucun collaborateur trouvé.</div>';
      return;
    }

    grid.innerHTML = users.map(renderCollabCard).join('');
    hydrateCollabAvatars(grid);
  }

  function collabFilterCurrentValue() {
    if (collabFilters.includeInactive) return 'inactive';
    if (collabFilters.contractTypes.length === 1) return 'contract:' + collabFilters.contractTypes[0];
    if (collabFilters.siteIds.length === 1) return 'site:' + collabFilters.siteIds[0];
    return 'all';
  }

  function renderCollabFilterSelect() {
    const sel = document.getElementById('collab-filter-select');
    if (!sel) return;
    const current = collabFilterCurrentValue();
    let html = '<option value="all">Tous</option>';
    html += '<optgroup label="Contrat">';
    html += '<option value="contract:CDI">CDI</option>';
    html += '<option value="contract:CDD">CDD</option>';
    html += '<option value="contract:INTERIM">Intérim</option>';
    html += '</optgroup>';
    const sites = collabSitesCache || [];
    if (sites.length) {
      html += '<optgroup label="Établissement">';
      sites.forEach(function (s) {
        html += `<option value="site:${esc(s.id)}">${esc(s.name)}</option>`;
      });
      html += '</optgroup>';
    }
    html += '<option value="inactive">Inactifs</option>';
    sel.innerHTML = html;
    const hasCurrent = [].some.call(sel.options, function (o) { return o.value === current; });
    sel.value = hasCurrent ? current : 'all';
  }

  function renderCollabPaginationBar() {
    const bar = document.getElementById('collab-pagination');
    if (!bar) return;
    const p = collabPagination;
    if (p.totalPages <= 1 && !p.total) {
      bar.innerHTML = '';
      return;
    }
    const from = p.total ? (p.page - 1) * p.limit + 1 : 0;
    const to = Math.min(p.page * p.limit, p.total);
    bar.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--text-2)">
        <span>${from}–${to} sur ${p.total}</span>
        <select class="form-input" style="width:auto;padding:4px 8px;font-size:12px" onchange="collabChangeSort(this.value)">
          <option value="lastName"${p.sort === 'lastName' ? ' selected' : ''}>Nom</option>
          <option value="firstName"${p.sort === 'firstName' ? ' selected' : ''}>Prénom</option>
          <option value="email"${p.sort === 'email' ? ' selected' : ''}>E-mail</option>
          <option value="createdAt"${p.sort === 'createdAt' ? ' selected' : ''}>Date d'entrée</option>
        </select>
        <button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" ${p.page <= 1 ? 'disabled' : ''} onclick="collabChangePage(${p.page - 1})">← Préc.</button>
        <span>Page ${p.page} / ${p.totalPages}</span>
        <button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" ${p.page >= p.totalPages ? 'disabled' : ''} onclick="collabChangePage(${p.page + 1})">Suiv. →</button>
      </div>`;
  }

  function collabChangePage(page) {
    if (page < 1 || page > collabPagination.totalPages) return;
    collabPagination.page = page;
    loadCollaborateursPage();
  }

  function collabChangeSort(sort) {
    collabPagination.sort = sort;
    collabPagination.page = 1;
    loadCollaborateursPage();
  }

  async function exportCollabsCsv() {
    try {
      ensureApiUsers();
      const blob = await api.exportUsersCsv({
        search: collabFilters.search || undefined,
        contractTypes: collabFilters.contractTypes.length ? collabFilters.contractTypes.join(',') : undefined,
        siteIds: collabFilters.siteIds.length ? collabFilters.siteIds.join(',') : undefined,
        sort: collabPagination.sort,
        order: collabPagination.order,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'collaborateurs.csv';
      a.click();
      URL.revokeObjectURL(url);
      if (typeof showToast === 'function') showToast('Export CSV téléchargé');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur export');
    }
  }

  function ensureApiUsers() {
    if (typeof api === 'undefined' || typeof api.users !== 'function') {
      throw new Error('Client API non chargé — rechargez la page (Ctrl+F5).');
    }
  }

  async function loadCollaborateursPage(forceRefresh) {
    const page = document.getElementById('page-collaborateurs');
    if (!page) return;

    const grid = page.querySelector('.collab-grid');
    if (!grid) return;

    if (forceRefresh) invalidateCollabListCache();

    const cacheKey = collabListCacheKey();
    if (!forceRefresh && collabListCache && collabListCache.key === cacheKey
      && Date.now() - collabListCache.at < COLLAB_LIST_CACHE_MS) {
      applyCollaborateursPageData(collabListCache.data);
      return;
    }
    if (!forceRefresh && collabListFetchPromise && collabListFetchKey === cacheKey) {
      return collabListFetchPromise;
    }

    grid.innerHTML = '<div style="padding:32px;color:var(--text-3);font-size:13.5px">Chargement…</div>';
    collabListFetchKey = cacheKey;

    collabListFetchPromise = (async function () {
      try {
        ensureApiUsers();
        const data = await Promise.race([
          api.users(collabBuildApiFilters()),
          new Promise(function (_, reject) {
            setTimeout(function () { reject(new Error('Délai dépassé — vérifiez que le backend tourne (port 3001).')); }, 12000);
          }),
        ]);
        if (!data.catalog && (!collabJobPositionsCache.length || !collabPolesCache.length)) {
          await loadCollabCatalog();
        }
        collabListCache = { key: cacheKey, at: Date.now(), data: data };
        applyCollaborateursPageData(data);
      } catch (err) {
        grid.innerHTML = `<div style="padding:32px;color:#DC2626;font-size:13.5px">${esc(err.error || err.message || 'Erreur de chargement')}</div>`;
      } finally {
        collabListFetchPromise = null;
      }
    })();

    return collabListFetchPromise;
  }

  function onCollabFilterChange(value) {
    collabFilters.contractTypes = [];
    collabFilters.siteIds = [];
    collabFilters.includeInactive = false;

    if (value === 'inactive') {
      collabFilters.includeInactive = true;
    } else if (value && value.indexOf('contract:') === 0) {
      collabFilters.contractTypes = [value.slice(9)];
    } else if (value && value.indexOf('site:') === 0) {
      collabFilters.siteIds = [value.slice(5)];
    }

    collabPagination.page = 1;
    loadCollaborateursPage();
  }

  function debouncedCollabSearch(q) {
    clearTimeout(collabSearchTimer);
    collabSearchTimer = setTimeout(function () {
      collabFilters.search = (q || '').trim();
      collabPagination.page = 1;
      loadCollaborateursPage();
    }, 300);
  }

  function renderCollabView(user) {
    collabCurrentUser = user;
    collabEditMode = false;
    document.getElementById('collab-modal-title').textContent = user.shortName + ' — Fiche';
    const hoursInfo = collabHoursSummaryHtml(user.weeklyHours, user.contractType, user);
    const hours = user.weeklyHours != null
      ? `${user.weeklyHours}h/sem. · max ${user.maxWeeklyHoursPlanning || hoursInfo.lim.maxWeeklyHoursPlanning}h`
      : '—';

    document.getElementById('collab-modal-body').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div class="collab-meta-item"><div class="collab-meta-label">Poste</div><div class="collab-meta-val">${esc(user.jobTitle || '—')}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Établissement</div><div class="collab-meta-val">${esc(user.siteName || '—')}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Contrat</div><div class="collab-meta-val"><span class="contract-badge ${esc(user.contractBadgeClass || 'cdi')}">${esc(user.contractLabel || 'CDI')}</span>${user.contractEndDate ? ' · fin ' + esc(user.contractEndDate) : ''}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Manager</div><div class="collab-meta-val">${esc(user.manager?.fullName || user.manager?.name || '—')}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Rôle applicatif</div><div class="collab-meta-val">${esc(user.role)}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Volume horaire</div><div class="collab-meta-val">${hours}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Taux horaire brut</div><div class="collab-meta-val">${collabFormatHourlyRate(user.hourlyRate)}${user.hourlyRate == null ? ' <span style="font-size:11px;color:var(--text-3)">(défaut société)</span>' : ''}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">E-mail</div><div class="collab-meta-val" style="font-size:12px">${esc(user.email)}</div></div>
        <div class="collab-meta-item"><div class="collab-meta-label">Téléphone</div><div class="collab-meta-val">${esc(user.phone || '—')}</div></div>
      </div>
      <div style="margin-bottom:10px">
        <div class="collab-meta-label" style="margin-bottom:6px">Pôles / rôles opérationnels</div>
        <div>${collabChipHtml(user.secondaryRoles, '#6366F1')}</div>
      </div>
      <div>
        <div class="collab-meta-label" style="margin-bottom:6px">Compétences</div>
        <div>${collabChipHtml(user.competences)}</div>
      </div>`;

    document.getElementById('collab-modal-footer').innerHTML = user.isActive === false
      ? `<button class="btn btn-ghost" onclick="closeModal('modal-collab')">Fermer</button>
         <button class="btn btn-primary" onclick="reactivateCollab()">Réactiver</button>`
      : `<button class="btn btn-ghost" onclick="closeModal('modal-collab')">Fermer</button>
      <button class="btn btn-ghost" onclick="resendCollabInvite()">✉ Renvoyer l'invitation</button>
      <button class="btn btn-ghost" style="color:var(--red)" onclick="deactivateCollab()">Désactiver</button>
      <button class="btn btn-ghost" onclick="collabGoPlanning()">Voir planning</button>
      <button class="btn btn-primary" onclick="collabStartEdit()">Modifier</button>`;
    document.getElementById('modal-collab').classList.add('open');
  }

  async function collabStartEdit() {
    if (!collabCurrentUser) return;
    collabEditMode = true;
    await ensureCollabManagersCache(true);
    document.getElementById('collab-modal-title').textContent = 'Modifier — ' + collabCurrentUser.shortName;
    document.getElementById('collab-modal-body').innerHTML = renderCollabFormFields('cedit', collabCurrentUser, collabSitesCache);
    collabJobSelectChange('cedit');
    collabUpdateHoursLimits('cedit');
    collabContractChange('cedit');
    document.getElementById('collab-modal-footer').innerHTML = `
      <button class="btn btn-ghost" onclick="collabCancelEdit()">Annuler</button>
      <button class="btn btn-primary" onclick="saveCollabEdit()">Enregistrer</button>`;
  }

  function collabCancelEdit() {
    if (collabCurrentUser) renderCollabView(collabCurrentUser);
  }

  async function saveCollabEdit() {
    if (!collabCurrentUser) return;
    const data = readCollabForm('cedit');
    if (!data.firstName || !data.lastName || !data.email) {
      if (typeof showToast === 'function') showToast('Prénom, nom et e-mail sont obligatoires.');
      return;
    }
    if (data.hourlyRate != null && (data.hourlyRate <= 0 || data.hourlyRate > 999)) {
      if (typeof showToast === 'function') showToast('Le taux horaire doit être compris entre 0,01 et 999 €.');
      return;
    }
    try {
      const res = await api.updateUser(collabCurrentUser.id, data);
      collabCurrentUser = res.user;
      if (typeof showToast === 'function') showToast('Profil mis à jour');
      renderCollabView(res.user);
      loadCollaborateursPage(true);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur de sauvegarde');
    }
  }

  async function openCollabModal(userId) {
    if (!userId) return;
    try {
      const cached = collabUsersCache.find(function (u) { return u.id === userId; });
      if (cached) {
        renderCollabView(cached);
        return;
      }
      const res = await api.user(userId);
      renderCollabView(res.user);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Impossible de charger le profil');
    }
  }

  function collabGoPlanning() {
    if (!collabCurrentUser) return;
    window.planCollabFilterApiUserId = collabCurrentUser.id;
    if (typeof showPage === 'function') showPage('planning', null);
    if (typeof closeModal === 'function') closeModal('modal-collab');
    if (typeof renderPlanning === 'function') renderPlanning();
    if (typeof showToast === 'function') showToast('Planning filtré sur ' + collabCurrentUser.shortName);
  }

  function collabCanManageUsers() {
    const role = (typeof Auth !== 'undefined' && Auth.user && Auth.user.role) || '';
    return ['MANAGER', 'RH', 'DRH', 'ADMIN'].indexOf(role) >= 0;
  }

  function collabResendScopeLabel() {
    const role = (typeof Auth !== 'undefined' && Auth.user && Auth.user.role) || '';
    return role === 'MANAGER'
      ? 'les collaborateurs actifs de votre équipe'
      : 'tous les collaborateurs actifs de l\'entreprise';
  }

  function updateCollabResendAllButton() {
    const btn = document.getElementById('collab-resend-all-btn');
    if (!btn) return;
    btn.style.display = collabCanManageUsers() ? '' : 'none';
  }

  async function resendCollabInvite() {
    if (!collabCurrentUser) return;
    if (!confirm(
      'Renvoyer l\'invitation à ' + collabCurrentUser.shortName + ' ?\n\n'
      + 'Un nouveau mot de passe temporaire sera généré et envoyé par e-mail.',
    )) return;
    try {
      ensureApiUsers();
      if (typeof api.resendUserInvite !== 'function') {
        throw new Error('Client obsolète — rechargez la page (Ctrl+F5).');
      }
      const res = await api.resendUserInvite(collabCurrentUser.id);
      if (typeof showToast === 'function') showToast(res.message || 'Invitation renvoyée');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur envoi');
    }
  }

  async function resendAllCollabInvites() {
    if (!collabCanManageUsers()) return;
    const scope = collabResendScopeLabel();
    const siteIds = collabFilters.siteIds.length === 1 ? collabFilters.siteIds : undefined;
    const siteHint = siteIds ? ' (établissement filtré)' : '';
    if (!confirm(
      'Renvoyer les invitations à ' + scope + siteHint + ' ?\n\n'
      + 'Chaque personne recevra un nouveau mot de passe temporaire par e-mail. Les anciens mots de passe ne fonctionneront plus.',
    )) return;
    const btn = document.getElementById('collab-resend-all-btn');
    if (btn) btn.disabled = true;
    try {
      ensureApiUsers();
      if (typeof api.resendUserInvites !== 'function') {
        throw new Error('Client obsolète — rechargez la page (Ctrl+F5).');
      }
      const payload = {};
      if (siteIds) payload.siteIds = siteIds;
      const res = await api.resendUserInvites(payload);
      if (typeof showToast === 'function') {
        showToast(res.message || (res.async
          ? 'Envoi démarré — les e-mails partent en arrière-plan.'
          : 'Invitations renvoyées'));
      }
      if (res.results && res.processed && res.emailsSent < res.processed) {
        console.info('[collab] invitations sans e-mail:', res.results.filter(function (r) { return !r.emailSent; }));
      }
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur envoi');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function deactivateCollab() {
    if (!collabCurrentUser) return;
    if (!confirm('Désactiver ' + collabCurrentUser.shortName + ' ? Le compte ne pourra plus se connecter.')) return;
    try {
      await api.deactivateUser(collabCurrentUser.id);
      if (typeof closeModal === 'function') closeModal('modal-collab');
      if (typeof showToast === 'function') showToast('Collaborateur désactivé');
      invalidateCollabCaches();
      collabCurrentUser = null;
      loadCollaborateursPage(true);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  async function reactivateCollab() {
    if (!collabCurrentUser) return;
    try {
      const res = await api.reactivateUser(collabCurrentUser.id);
      collabCurrentUser = res.user;
      if (typeof showToast === 'function') showToast('Collaborateur réactivé');
      invalidateCollabCaches();
      renderCollabView(res.user);
      loadCollaborateursPage(true);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  }

  async function openAddCollab() {
    if (!collabSitesCache.length) {
      try {
        const res = await api.userSites();
        collabSitesCache = res.sites || [];
      } catch (_e) { /* optional */ }
    }
    if (!collabJobPositionsCache.length || !collabPolesCache.length) {
      await loadCollabCatalog();
    }
    await ensureCollabManagersCache(true);
    document.getElementById('add-collab-form-body').innerHTML = renderCollabFormFields('cadd', {}, collabSitesCache);
    collabContractChange('cadd');
    collabUpdateHoursLimits('cadd');
    document.getElementById('modal-add-collab').classList.add('open');
  }

  async function submitAddCollab() {
    const data = readCollabForm('cadd');
    if (!data.firstName || !data.lastName || !data.email) {
      if (typeof showToast === 'function') showToast('Prénom, nom et e-mail sont obligatoires.');
      return;
    }
    if (data.hourlyRate != null && (data.hourlyRate <= 0 || data.hourlyRate > 999)) {
      if (typeof showToast === 'function') showToast('Le taux horaire doit être compris entre 0,01 et 999 €.');
      return;
    }
    try {
      const res = await api.createUser(data);
      if (typeof closeModal === 'function') closeModal('modal-add-collab');
      if (typeof showToast === 'function') {
        let msg = res.invite?.message;
        if (!msg && res.invited) {
          msg = res.invite?.message || 'Invitation envoyée — le collaborateur rejoindra votre entreprise avec son compte existant.';
        }
        if (!msg && res.reactivated) {
          msg = res.invite?.message || 'Collaborateur réactivé dans votre entreprise.';
        }
        if (!msg) {
          msg = 'Collaborateur créé · mot de passe : ' + (res.defaultPassword || '(voir e-mail)');
        }
        showToast(msg);
      }
      invalidateCollabCaches();
      loadCollaborateursPage(true);
      if (res.user) renderCollabView(res.user);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur de création');
    }
  }

  function patchCollabGlobalSearch() {
    if (typeof handleSearch !== 'function' || handleSearch.__collabPatched) return;
    const original = handleSearch;
    window.handleSearch = function (q) {
      const collabPage = document.getElementById('page-collaborateurs');
      const isVisible = collabPage && collabPage.classList.contains('active');
      if (isVisible && q && q.length >= 2) {
        const searchIn = document.getElementById('collab-search');
        if (searchIn) searchIn.value = q;
        debouncedCollabSearch(q);
      }
      original(q);
    };
    handleSearch.__collabPatched = true;
  }

  /* ─── Mes paramètres (profil collaborateur) ───────────────── */

  const PROFILE_NOTIF_DEFAULTS = {
    qcm_daily: true,
    planning_changed: true,
    leave_response: true,
    payslip_new: false,
  };

  function profileNotifStorageKey(userId) {
    return 'pulsiia_profile_notifs_' + (userId || 'anon');
  }

  function readProfileNotifs(userId) {
    try {
      const raw = localStorage.getItem(profileNotifStorageKey(userId));
      if (!raw) return Object.assign({}, PROFILE_NOTIF_DEFAULTS);
      return Object.assign({}, PROFILE_NOTIF_DEFAULTS, JSON.parse(raw));
    } catch (_e) {
      return Object.assign({}, PROFILE_NOTIF_DEFAULTS);
    }
  }

  function writeProfileNotifs(userId, prefs) {
    localStorage.setItem(profileNotifStorageKey(userId), JSON.stringify(prefs));
  }

  function formatIbanInput(value) {
    const clean = String(value || '').replace(/\s+/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return clean.replace(/(.{4})/g, '$1 ').trim();
  }

  function loadProfileNotifToggles(userId) {
    const prefs = readProfileNotifs(userId);
    document.querySelectorAll('#page-mes-params .toggle[data-notif-key]').forEach(function (el) {
      const key = el.getAttribute('data-notif-key');
      el.classList.toggle('on', !!prefs[key]);
    });
  }

  window.toggleProfileNotif = function (el) {
    if (!el) return;
    el.classList.toggle('on');
    const key = el.getAttribute('data-notif-key');
    if (!key) return;
    const userId = (typeof Auth !== 'undefined' && Auth.user && Auth.user.id) || 'anon';
    const prefs = readProfileNotifs(userId);
    prefs[key] = el.classList.contains('on');
    writeProfileNotifs(userId, prefs);
    if (typeof showToast === 'function') showToast('Préférence notification enregistrée');
  };

  async function loadMesParamsPage() {
    const page = document.getElementById('page-mes-params');
    if (!page || typeof api.updateMyProfile !== 'function') return;

    try {
      const res = typeof api.myProfile === 'function' ? await api.myProfile() : null;
      const u = res?.user;
      if (!u) return;

      const subtitle = document.getElementById('params-subtitle');
      if (subtitle) subtitle.textContent = `${u.shortName} · ${u.jobTitle || u.role} · ${u.siteName || '—'}`;

      const avatar = document.getElementById('params-avatar');
      if (avatar) {
        avatar.style.backgroundImage = '';
        if (u.avatarUrl && typeof Auth !== 'undefined' && Auth.accessToken) {
          avatar.textContent = '';
          fetch(u.avatarUrl, { headers: { Authorization: 'Bearer ' + Auth.accessToken } })
            .then(function (r) { return r.ok ? r.blob() : null; })
            .then(function (b) {
              if (b) avatar.style.backgroundImage = 'url(' + URL.createObjectURL(b) + ')';
            }).catch(function () { /* fallback initials */ });
        } else {
          avatar.textContent = u.initials || '??';
          if (u.avatarColor) avatar.style.background = u.avatarColor;
        }
      }

      const nameBlock = document.getElementById('params-display-name');
      if (nameBlock) nameBlock.textContent = u.fullName || u.shortName;
      const roleBlock = document.getElementById('params-display-role');
      if (roleBlock) {
        roleBlock.textContent = `${u.jobTitle || u.role} · ${u.siteName || '—'} · ${u.contractLabel || 'CDI'}`;
      }

      const fn = document.getElementById('params-firstname');
      const ln = document.getElementById('params-lastname');
      const em = document.getElementById('params-email');
      const tel = document.getElementById('params-tel');
      const iban = document.getElementById('params-iban');
      if (fn) fn.value = u.firstName || '';
      if (ln) ln.value = u.lastName || '';
      if (em) em.value = u.email || '';
      if (tel) tel.value = u.phone || '';
      if (iban) iban.value = u.iban || '';

      loadProfileNotifToggles(u.id);
      if (typeof loadMesParamsRgpd === 'function') loadMesParamsRgpd();
    } catch (err) {
      console.warn('Mes paramètres:', err.error || err.message);
    }
  }

  async function uploadProfileAvatar(input) {
    const file = input?.files?.[0];
    if (!file || typeof api.uploadMyAvatar !== 'function') return;
    try {
      const res = await api.uploadMyAvatar(file);
      if (typeof showToast === 'function') showToast('Photo de profil mise à jour');
      loadMesParamsPage();
      if (res.user && typeof Auth !== 'undefined') Auth.user = Object.assign(Auth.user || {}, res.user);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur upload');
    } finally {
      if (input) input.value = '';
    }
  }

  async function importCollabsCsv(input) {
    const file = input?.files?.[0];
    if (!file || typeof api.importUsersCsv !== 'function') return;
    try {
      const csv = await file.text();
      const res = await api.importUsersCsv(csv);
      if (typeof showToast === 'function') {
        showToast(res.message + (res.defaultPassword ? ' · MDP : ' + res.defaultPassword : ''));
      }
      if (typeof invalidatePlanningCache === 'function') invalidatePlanningCache();
      invalidateCollabCaches();
      loadCollaborateursPage(true);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur import');
    } finally {
      if (input) input.value = '';
    }
  }

  function patchSaveProfile() {
    if (typeof window.saveProfile === 'undefined' || window.saveProfile.__pagesApiPatched) return;
    window.saveProfile = async function () {
      const btn = event?.target;
      const ibanRaw = document.getElementById('params-iban')?.value || '';
      const data = {
        firstName: document.getElementById('params-firstname')?.value.trim(),
        lastName: document.getElementById('params-lastname')?.value.trim(),
        phone: document.getElementById('params-tel')?.value.trim() || null,
        iban: ibanRaw.replace(/\s+/g, '').toUpperCase() || null,
      };
      if (btn) { btn.textContent = 'Enregistrement…'; btn.disabled = true; }
      try {
        if (typeof api.updateMyProfile === 'function') {
          await api.updateMyProfile(data);
        }
        if (btn) { btn.textContent = '✓ Enregistré'; btn.style.background = 'var(--green)'; }
        if (typeof showToast === 'function') showToast('Profil mis à jour');
        loadMesParamsPage();
      } catch (err) {
        if (typeof showToast === 'function') showToast(err.error || 'Erreur de sauvegarde');
      } finally {
        setTimeout(function () {
          if (btn) { btn.textContent = 'Enregistrer'; btn.disabled = false; btn.style.background = ''; }
        }, 2000);
      }
    };
    window.saveProfile.__pagesApiPatched = true;
  }

  function getCollabCatalogPostes() {
    return collabJobPositionsCache.slice();
  }

  function getCollabCatalogPoles() {
    return collabPolesCache.slice();
  }

  async function syncPlanningCollabsFromApi() {
    if (typeof COLLABS === 'undefined' || typeof api.users !== 'function') return;
    try {
      await loadCollabCatalog();
      const res = await api.users({ limit: 100 });
      const users = res.users || [];
      if (typeof planUsersCache !== 'undefined') planUsersCache = users;

      users.forEach(function (u) {
        const sn = u.shortName;
        let collab = COLLABS.find(function (c) { return c.name === sn; });
        if (!collab) {
          const parts = sn.replace(/\./g, '').split(/\s+/);
          collab = COLLABS.find(function (c) {
            const cp = c.name.replace(/\./g, '').split(/\s+/);
            return cp[0] === parts[0] && cp[1] && parts[1] && cp[1][0] === parts[1][0];
          });
        }
        if (collab) {
          collab.apiUserId = u.id;
          collab.poste = u.jobTitle || collab.poste;
          collab.competences = u.competences || collab.competences;
          collab.secondaryRoles = u.secondaryRoles || collab.secondaryRoles;
          if (u.siteName) {
            const siteShort = u.siteName.replace(' Centre', '').replace('Siège ', '');
            collab.site = siteShort;
          }
        }
      });
    } catch (_e) { /* optional */ }
  }

  /* ─── Organigramme ───────────────────────────────────────── */

  async function loadOrganigrammePage() {
    try {
      const data = await api.orgChart();
      const people = data.people || [];
      if (typeof ORG_DATA !== 'undefined' && Array.isArray(people) && people.length > 0) {
        ORG_DATA.length = 0;
        people.forEach(function (p) {
          ORG_DATA.push({
            id: p.id,
            name: p.name,
            fullName: p.fullName,
            role: p.role,
            dept: p.dept,
            site: typeof normalizeOrgSite === 'function' ? normalizeOrgSite(p.site) : p.site,
            color: p.color,
            manager: p.manager,
            email: p.email,
            teams: (p.email || '').split('@')[0] || 'user',
            tel: p.tel || '',
            contrat: p.contrat,
            entree: p.entree,
          });
        });
        if (typeof normalizeAllOrgSites === 'function') normalizeAllOrgSites();
        if (typeof setOrgStats === 'function') setOrgStats(data.stats, data.permissions);
        if (typeof refreshOrgSiteFilter === 'function') refreshOrgSiteFilter();
      } else if (typeof ORG_DATA !== 'undefined') {
        ORG_DATA.length = 0;
        if (typeof setOrgStats === 'function') setOrgStats(data.stats || {}, data.permissions);
        if (typeof refreshOrgSiteFilter === 'function') refreshOrgSiteFilter();
      }

      if (typeof applyOrgAccessUI === 'function') applyOrgAccessUI();
      if (typeof orgView !== 'undefined' && typeof setOrgView === 'function') {
        setOrgView(orgView || (typeof isOrgCollabView === 'function' && isOrgCollabView() ? 'dir' : 'tree'));
      }
    } catch (err) {
      console.warn('Organigramme:', err.error || err.message);
      if (typeof applyOrgAccessUI === 'function') applyOrgAccessUI();
      if (typeof setOrgView === 'function') setOrgView(typeof isOrgCollabView === 'function' && isOrgCollabView() ? 'dir' : 'tree');
    }
  }

  /* ─── Documents RH ───────────────────────────────────────── */

  let docsApiReady = false;
  let docsSignatureProvider = 'Yousign';
  let docVersionTargetId = null;

  function docBuildApiFilters() {
    const f = {};
    const site = document.getElementById('doc-site-filter')?.value;
    const search = document.getElementById('doc-search')?.value?.trim();
    if (site) f.siteId = site;
    if (search) f.search = search;
    if (typeof docType !== 'undefined' && docType && docType !== 'Tous') f.type = docType;
    return f;
  }

  async function loadDocSiteFilter() {
    const sel = document.getElementById('doc-site-filter');
    if (!sel || typeof api.userSites !== 'function') return;
    try {
      const { sites } = await api.userSites();
      const cur = sel.value;
      sel.innerHTML = '<option value="">Tous les établissements</option>'
        + (sites || []).map(function (s) {
          return '<option value="' + s.id + '">' + (s.name || s.id) + '</option>';
        }).join('');
      if (cur) sel.value = cur;
    } catch (_e) { /* ignore */ }
  }

  window.loadDocumentsPageFromUi = function () {
    if (typeof loadDocumentsPage === 'function') loadDocumentsPage();
  };

  function docCollabColor(d) {
    if (d.avatarColor) return d.avatarColor;
    if (typeof COLLAB_COLOR !== 'undefined' && COLLAB_COLOR[d.collab]) return COLLAB_COLOR[d.collab];
    return '#6B7280';
  }

  function docCollabInit(d) {
    if (d.initials) return d.initials;
    if (typeof COLLAB_INIT !== 'undefined' && COLLAB_INIT[d.collab]) return COLLAB_INIT[d.collab];
    return (d.collab || '—').slice(0, 2).toUpperCase();
  }

  let _ssCollabsCache = null;

  async function loadAllSsCollabsFromApi() {
    if (typeof SS_DATA === 'undefined' || typeof api === 'undefined' || typeof api.users !== 'function') return;
    try {
      const data = await api.users({});
      const users = data.users || [];
      const ssItems = users.filter(function (u) { return u.isActive !== false; }).map(function (u) {
        const label = u.shortName || (u.firstName + ' ' + (u.lastName || '').charAt(0) + '.');
        return {
          value: u.id,
          label: label,
          site: (u.site && u.site.name) || u.siteName || '',
          color: u.avatarColor || '#6B7280',
          init: u.initials || ((u.firstName || '')[0] + (u.lastName || '')[0]).toUpperCase(),
        };
      });
      _ssCollabsCache = ssItems;
      ['doc-form-collab', 'pp-add-collab', 'dec-collab', 'dem-collab', 'tr-collab'].forEach(function (key) {
        SS_DATA[key] = ssItems.slice();
        if (typeof ssRenderList === 'function') ssRenderList(key, '');
      });
    } catch (_e) { /* garde la liste statique */ }
  }

  async function loadDocumentsCollabSelect() {
    await loadAllSsCollabsFromApi();
  }

  async function updateDocPageSubtitle() {
    const el = document.getElementById('doc-page-subtitle');
    if (!el) return;
    let company = 'Groupe Saveurs & Co';
    try {
      if (typeof api !== 'undefined' && api.me) {
        const me = await api.me();
        if (me?.company?.name) company = me.company.name;
      } else if (window.Auth?.user && typeof orgStats !== 'undefined') {
        company = orgStats.companyName || company;
      }
    } catch (_e) { /* fallback */ }
    el.textContent = 'Tous les documents du groupe · ' + company;
  }

  async function loadDocumentsPage() {
    if (typeof docs === 'undefined' || typeof renderDocs !== 'function') return;

    await loadDocumentsCollabSelect();
    await loadDocSiteFilter();
    updateDocPageSubtitle();

    try {
      const res = await api.documents(docBuildApiFilters());
      const documents = res.documents || [];
      const stats = res.stats;
      docsSignatureProvider = res.signatureProvider || 'Yousign';
      docs.length = 0;
      documents.forEach(function (d) {
        docs.push({
          id: d.id,
          userId: d.userId,
          name: d.name,
          collab: d.collab,
          type: d.type,
          date: d.date,
          status: d.status,
          initials: d.initials,
          avatarColor: d.avatarColor,
          siteName: d.siteName,
          versionNumber: d.versionNumber,
          rootFileId: d.rootFileId,
          signatureProvider: d.signatureProvider,
          signatureStatus: d.signatureStatus,
          signatureLink: d.signatureLink,
        });
      });
      docsApiReady = true;

      const hint = document.getElementById('doc-yousign-hint');
      if (hint) {
        hint.innerHTML = res.signatureConfigured
          ? 'Signatures via <strong>Yousign</strong> (prestataire français agréé, conforme eIDAS — niveau avancé par défaut).'
          : 'Configurez <code>YOUSIGN_API_KEY</code> (sandbox gratuite sur <a href="https://yousign.com" target="_blank" rel="noopener">yousign.com</a>) pour activer les signatures eIDAS.';
      }

      if (stats) {
        const kpiTotal = document.getElementById('doc-kpi-total');
        if (kpiTotal) kpiTotal.textContent = String(stats.total);
        const kb = document.getElementById('doc-kpi-bulletins');
        const kc = document.getElementById('doc-kpi-contrats');
        const kp = document.getElementById('doc-kpi-pending');
        if (kb) kb.textContent = String(stats.bulletins);
        if (kc) kc.textContent = String(stats.contrats);
        if (kp) kp.textContent = String(stats.pending);
      }

      renderDocs();
    } catch (err) {
      console.warn('Documents RH:', err.error || err.message);
      docsApiReady = false;
      renderDocs();
    }
  }

  async function exportDocumentsZip() {
    if (!docsApiReady || typeof api.downloadDocumentsZip !== 'function') {
      if (typeof showToast === 'function') showToast('Export ZIP indisponible hors connexion API');
      return;
    }
    try {
      if (typeof showToast === 'function') showToast('Préparation de l\'archive ZIP…');
      await api.downloadDocumentsZip(docBuildApiFilters());
      if (typeof showToast === 'function') showToast('Archive ZIP téléchargée ✓');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur export ZIP');
    }
  }

  window.exportDocumentsZip = exportDocumentsZip;

  async function startDocSignature(id) {
    if (!docsApiReady || typeof api.startDocumentSignature !== 'function') {
      if (typeof showToast === 'function') showToast('Signature Yousign indisponible');
      return;
    }
    try {
      const res = await api.startDocumentSignature(id);
      if (res.signature?.signatureLink && typeof showToast === 'function') {
        showToast('Procédure Yousign envoyée au signataire ✓');
      } else if (res.signature?.message) {
        showToast(res.signature.message);
      } else {
        showToast('Signature Yousign initiée ✓');
      }
      await loadDocumentsPage();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur Yousign');
    }
  }

  window.startDocSignature = startDocSignature;

  async function openDocVersionsModal(id) {
    docVersionTargetId = id;
    const listEl = document.getElementById('doc-versions-list');
    if (!listEl) return;
    listEl.innerHTML = '<div style="padding:12px;color:var(--text-3)">Chargement…</div>';
    document.getElementById('modal-doc-versions')?.classList.add('open');
    if (!docsApiReady) {
      listEl.innerHTML = '<div style="padding:12px">API non connectée</div>';
      return;
    }
    try {
      const res = await api.documentVersions(id);
      const versions = res.versions || [];
      if (!versions.length) {
        listEl.innerHTML = '<div style="padding:12px;color:var(--text-3)">Aucune version</div>';
        return;
      }
      listEl.innerHTML = versions.map(function (v) {
        return '<div style="padding:10px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">'
          + '<div style="font-weight:600">v' + v.versionNumber + (v.isCurrent ? ' <span style="color:var(--green);font-size:11px">· actuelle</span>' : '') + '</div>'
          + '<div style="font-size:12px;color:var(--text-3);margin-top:4px">' + v.date + ' · ' + v.status + '</div>'
          + (v.isCurrent ? '' : '<button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px;margin-top:6px" onclick="downloadDocById(\'' + v.id + '\')">Télécharger</button>')
          + '</div>';
      }).join('');
    } catch (err) {
      listEl.innerHTML = '<div style="color:var(--red);padding:12px">' + (err.error || err.message) + '</div>';
    }
  }

  window.openDocVersionsModal = openDocVersionsModal;

  async function submitDocVersion() {
    const file = document.getElementById('doc-version-file')?.files?.[0];
    const err = document.getElementById('doc-version-error');
    if (!docVersionTargetId || !file) {
      if (err) { err.style.display = 'block'; err.textContent = 'Sélectionnez un fichier.'; }
      return;
    }
    if (err) err.style.display = 'none';
    try {
      await api.uploadDocumentVersion(docVersionTargetId, file);
      if (typeof closeModal === 'function') closeModal('modal-doc-versions');
      await loadDocumentsPage();
      if (typeof showToast === 'function') showToast('Nouvelle version publiée ✓');
    } catch (e) {
      if (err) { err.style.display = 'block'; err.textContent = e.error || e.message || 'Erreur'; }
    }
  }

  window.submitDocVersion = submitDocVersion;

  function exportDocumentsCsv() {
    if (typeof filteredDocs !== 'function') return;
    const list = filteredDocs();
    const header = ['Document', 'Collaborateur', 'Type', 'Date', 'Statut'];
    const rows = list.map(function (d) {
      return [d.name, d.collab, d.type, d.date, d.status]
        .map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; })
        .join(';');
    });
    const csv = '\ufeff' + header.join(';') + '\n' + rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'documents_rh_' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    if (typeof showToast === 'function') showToast('Export CSV téléchargé ✓');
  }

  async function downloadDocById(id) {
    if (typeof api !== 'undefined' && typeof api.downloadDocument === 'function' && docsApiReady) {
      try {
        await api.downloadDocument(id);
        if (typeof showToast === 'function') showToast('Téléchargement démarré ✓');
        return;
      } catch (err) {
        if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur téléchargement');
        return;
      }
    }
    if (typeof showToast === 'function') showToast('Téléchargement démarré ✓');
  }

  async function showDocPreview(id) {
    const ph = document.getElementById('pv-placeholder');
    const phText = document.getElementById('pv-placeholder-text');
    const fr = document.getElementById('pv-frame');
    const im = document.getElementById('pv-img');

    if (window.docPreviewBlobUrl) {
      URL.revokeObjectURL(window.docPreviewBlobUrl);
      window.docPreviewBlobUrl = null;
    }

    if (!docsApiReady || typeof api.fetchDocumentBlob !== 'function') {
      if (phText) phText.textContent = 'Connectez-vous pour afficher l\'aperçu du fichier.';
      return;
    }

    try {
      const { url, mimeType } = await api.fetchDocumentBlob(id, true);
      window.docPreviewBlobUrl = url;
      if (ph) ph.style.display = 'none';
      if (mimeType.includes('pdf')) {
        if (fr) { fr.src = url; fr.style.display = 'block'; }
        if (im) im.style.display = 'none';
      } else if (mimeType.startsWith('image/')) {
        if (im) { im.src = url; im.style.display = 'block'; }
        if (fr) fr.style.display = 'none';
      } else {
        if (fr) fr.style.display = 'none';
        if (im) im.style.display = 'none';
        if (ph) { ph.style.display = 'flex'; }
        if (phText) phText.textContent = 'Aperçu non disponible pour ce type — utilisez Télécharger.';
      }
    } catch (err) {
      if (ph) ph.style.display = 'flex';
      if (phText) phText.textContent = err.error || err.message || 'Impossible de charger l\'aperçu.';
      if (fr) fr.style.display = 'none';
      if (im) im.style.display = 'none';
    }
  }

  function patchDocumentsHandlers() {
    if (window.__docsHandlersV2) return;
    window.__docsHandlersV2 = true;

    const origSave = typeof saveDoc === 'function' ? saveDoc : null;
    window.saveDoc = async function () {
      const editingId = document.getElementById('doc-editing-id')?.value?.trim();
      const collabId = document.getElementById('doc-form-collab')?.value;
      const type = document.getElementById('doc-form-type')?.value;
      const name = document.getElementById('doc-form-name')?.value?.trim();
      const date = document.getElementById('doc-form-date')?.value;
      const status = document.getElementById('doc-form-status')?.value;
      const err = document.getElementById('doc-form-error');
      const fileInput = document.getElementById('doc-form-file');

      if (!collabId) {
        if (err) { err.style.display = 'block'; err.textContent = 'Veuillez sélectionner un collaborateur.'; }
        return;
      }
      if (!name) {
        if (err) { err.style.display = 'block'; err.textContent = 'Veuillez saisir un nom de document.'; }
        return;
      }
      if (err) err.style.display = 'none';

      if (docsApiReady && typeof api !== 'undefined') {
        try {
          if (editingId && typeof api.updateDocument === 'function') {
            await api.updateDocument(editingId, {
              userId: collabId,
              name: name,
              type: type,
              status: status,
              date: date,
            });
            if (typeof closeModal === 'function') closeModal('modal-doc');
            await loadDocumentsPage();
            if (typeof showToast === 'function') showToast('Document modifié ✓');
            return;
          }
          if (typeof api.createDocument === 'function') {
            await api.createDocument(
              { userId: collabId, name: name, type: type, status: status, date: date },
              fileInput?.files?.[0] || null,
            );
            if (typeof docPage !== 'undefined') docPage = 1;
            if (typeof closeModal === 'function') closeModal('modal-doc');
            if (fileInput) fileInput.value = '';
            document.getElementById('doc-drop-zone')?.querySelector('.doc-file-label')?.remove();
            await loadDocumentsPage();
            if (typeof showToast === 'function') showToast('Document ajouté : ' + name + ' ✓');
            return;
          }
        } catch (apiErr) {
          if (err) {
            err.style.display = 'block';
            err.textContent = apiErr.error || apiErr.message || 'Erreur lors de l\'enregistrement.';
          }
          return;
        }
      }

      if (origSave) return origSave();
    };

    window.downloadDocById = downloadDocById;

    window.exportAllDocuments = function () {
      if (typeof showToast === 'function') showToast('Préparation de l\'export…');
      exportDocumentsCsv();
    };

    const origPreview = typeof previewDoc === 'function' ? previewDoc : null;
    window.previewDoc = async function (id) {
      currentDocId = id;
      if (origPreview) origPreview(id);
      await showDocPreview(id);
    };

    window.closeDocPreview = function () {
      if (window.docPreviewBlobUrl) {
        URL.revokeObjectURL(window.docPreviewBlobUrl);
        window.docPreviewBlobUrl = null;
      }
      const fr = document.getElementById('pv-frame');
      const im = document.getElementById('pv-img');
      if (fr) { fr.src = ''; fr.style.display = 'none'; }
      if (im) { im.src = ''; im.style.display = 'none'; }
      if (typeof closeModal === 'function') closeModal('modal-doc-preview');
    };

    const origDelete = typeof deleteDoc === 'function' ? deleteDoc : null;
    window.deleteDoc = async function (id) {
      const d = docs.find(function (x) { return x.id === id; });
      if (!d) return;
      if (!confirm('Supprimer « ' + d.name + ' » ?')) return;
      if (docsApiReady && typeof api.deleteDocument === 'function') {
        try {
          await api.deleteDocument(id);
          await loadDocumentsPage();
          if (typeof showToast === 'function') showToast('Document supprimé ✓');
          return;
        } catch (err) {
          if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur suppression');
          return;
        }
      }
      if (origDelete) origDelete(id);
    };

    window.relancerDoc = async function (id) {
      const d = docs.find(function (x) { return x.id === id; });
      if (docsApiReady && typeof api.remindDocument === 'function') {
        try {
          const res = await api.remindDocument(id);
          if (typeof showToast === 'function') showToast((res.message || 'Relance envoyée') + ' ✓');
          return;
        } catch (err) {
          if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur relance');
          return;
        }
      }
      if (d && typeof showToast === 'function') showToast('Relance envoyée à ' + d.collab + ' ✓');
    };

    window.downloadCurrentDoc = function () {
      const id = currentDocId;
      if (id) downloadDocById(id);
      else if (typeof showToast === 'function') showToast('Aucun document sélectionné');
    };

    const origOpen = typeof openDocModal === 'function' ? openDocModal : null;
    window.openDocModal = function () {
      if (origOpen) origOpen();
      const dateEl = document.getElementById('doc-form-date');
      if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
      loadDocumentsCollabSelect();
    };

    const origEdit = typeof openDocEditModal === 'function' ? openDocEditModal : null;
    window.openDocEditModal = function (id) {
      if (origEdit) origEdit(id);
      loadDocumentsCollabSelect();
    };
  }

  /* ─── Mes documents (collab) ─────────────────────────────── */

  let mesDocsApiReady = false;

  function formatBytesShort(n) {
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' Ko';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' Mo';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' Go';
  }

  function updateMesDocsCounts(stats) {
    const n = function (id, val) {
      const el = document.getElementById(id);
      if (el) el.textContent = val + ' document' + (val > 1 ? 's' : '');
    };
    if (!stats) return;
    n('mdcat-all-count', stats.total);
    n('mdcat-contrat-count', stats.contrat);
    n('mdcat-bulletin-count', stats.bulletin);
    n('mdcat-perso-count', stats.perso);
    const bar = document.getElementById('mes-docs-storage-bar');
    const label = document.getElementById('mes-docs-storage-label');
    if (bar && stats.quotaBytes) {
      const pct = Math.min(100, Math.round((stats.usedBytes / stats.quotaBytes) * 100));
      bar.style.width = pct + '%';
    }
    if (label) {
      label.textContent = formatBytesShort(stats.usedBytes || 0) + ' utilisés / ' + formatBytesShort(stats.quotaBytes || 0);
    }
  }

  async function updateMesDocsSubtitle() {
    const el = document.getElementById('mes-docs-subtitle');
    if (!el) return;
    try {
      const me = await api.me();
      const name = me ? (me.firstName + ' ' + (me.lastName || '').charAt(0) + '.') : '';
      el.textContent = (name.trim() || 'Mon espace') + ' · Documents personnels et RH · Stockage sécurisé';
    } catch (_e) {
      const u = window.Auth?.user;
      if (u) el.textContent = (u.firstName || '') + ' · Documents personnels et RH';
    }
  }

  function renderMesDocsLive() {
    if (typeof mesDocs === 'undefined') return;
    const list = typeof mesDocsFilter !== 'undefined' && mesDocsFilter !== 'all'
      ? mesDocs.filter(function (d) { return d.cat === mesDocsFilter; })
      : mesDocs.slice();
    const el = document.getElementById('mes-docs-list');
    if (!el) return;

    if (!list.length) {
      el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-3);font-size:13px">Aucun document dans cette catégorie</div>';
      return;
    }

    el.innerHTML = '<table style="width:100%;border-collapse:collapse"><thead><tr style="background:var(--bg)">'
      + '<th style="padding:10px 16px;font-size:11px;font-weight:600;color:var(--text-2);text-align:left;border-bottom:1px solid var(--border)">Document</th>'
      + '<th style="padding:10px 16px;font-size:11px;font-weight:600;color:var(--text-2);text-align:left;border-bottom:1px solid var(--border)">Date</th>'
      + '<th style="padding:10px 16px;font-size:11px;font-weight:600;color:var(--text-2);text-align:left;border-bottom:1px solid var(--border)">Taille</th>'
      + '<th style="padding:10px 16px;font-size:11px;font-weight:600;color:var(--text-2);text-align:left;border-bottom:1px solid var(--border)">Source</th>'
      + '<th style="padding:10px 16px;font-size:11px;font-weight:600;color:var(--text-2);text-align:left;border-bottom:1px solid var(--border)">Action</th>'
      + '</tr></thead><tbody>'
      + list.map(function (d, i) {
        const isLast = i === list.length - 1;
        const idArg = typeof d.id === 'string' ? "'" + d.id + "'" : d.id;
        const border = isLast ? '' : 'border-bottom:1px solid var(--border)';
        return '<tr>'
          + '<td style="padding:13px 16px;' + border + '"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:20px">' + d.icon + '</span>'
          + '<div><div style="font-size:13px;font-weight:500">' + d.name + '</div><div style="font-size:11px;color:var(--text-3);text-transform:capitalize">' + d.cat + '</div></div></div></td>'
          + '<td style="padding:13px 16px;font-size:12.5px;color:var(--text-2);' + border + '">' + d.date + '</td>'
          + '<td style="padding:13px 16px;font-size:12.5px;color:var(--text-2);' + border + '">' + d.size + '</td>'
          + '<td style="padding:13px 16px;' + border + '"><span style="font-size:11.5px;padding:2px 8px;border-radius:4px;background:' + (d.from === 'RH' ? '#EFF6FF' : '#ECFDF5') + ';color:' + (d.from === 'RH' ? 'var(--blue)' : 'var(--green)') + '">' + d.from + '</span></td>'
          + '<td style="padding:13px 16px;' + border + '"><div style="display:flex;gap:6px">'
          + '<button class="btn btn-ghost" style="padding:4px 10px;font-size:12px" onclick="downloadMesDoc(' + idArg + ')">↓ Voir</button>'
          + (d.from === 'Moi' ? '<button class="btn btn-ghost" style="padding:4px 10px;font-size:12px;color:var(--red)" onclick="deleteMesDoc(' + idArg + ')">Supprimer</button>' : '')
          + '</div></td></tr>';
      }).join('')
      + '</tbody></table>';
  }

  async function loadMesDocsPage() {
    if (typeof mesDocs === 'undefined') return;

    await updateMesDocsSubtitle();

    try {
      const res = await api.myDocuments();
      mesDocs.length = 0;
      (res.documents || []).forEach(function (d) {
        mesDocs.push({
          id: d.id,
          name: d.name,
          cat: d.cat,
          size: d.size,
          date: d.date,
          from: d.from,
          icon: d.icon,
        });
      });
      mesDocsApiReady = true;
      updateMesDocsCounts(res.stats);
      renderMesDocsLive();
    } catch (err) {
      console.warn('Mes documents:', err.error || err.message);
      mesDocsApiReady = false;
      if (typeof renderMesDocs === 'function') renderMesDocs();
    }
  }

  function resetMesUploadForm() {
    const err = document.getElementById('mes-upload-error');
    const nameEl = document.getElementById('mes-upload-name');
    const fi = document.getElementById('mes-upload-file');
    const label = document.getElementById('mes-upload-file-label');
    const drop = document.getElementById('mes-upload-drop');
    if (err) err.style.display = 'none';
    if (nameEl) nameEl.value = '';
    if (fi) fi.value = '';
    if (label) {
      label.textContent = 'Choisir un fichier';
      label.style.color = '';
    }
    if (drop) {
      drop.style.borderColor = 'var(--border)';
      drop.style.background = '';
    }
  }

  function updateMesUploadFileLabel(file) {
    const label = document.getElementById('mes-upload-file-label');
    const drop = document.getElementById('mes-upload-drop');
    const nameEl = document.getElementById('mes-upload-name');
    if (!file) return;
    if (label) {
      label.innerHTML = '✅ ' + file.name + '<br><span style="font-size:11px;font-weight:400;color:var(--text-3)">' +
        formatBytesShort(file.size) + '</span>';
      label.style.color = 'var(--green)';
    }
    if (drop) {
      drop.style.borderColor = 'var(--blue-mid)';
      drop.style.background = 'var(--blue-light)';
    }
    if (nameEl && !nameEl.value.trim()) {
      const base = file.name.replace(/\.[^.]+$/, '');
      nameEl.value = base;
    }
  }

  function wireMesUploadFileInput() {
    const fi = document.getElementById('mes-upload-file');
    if (!fi || fi.dataset.mesUploadWired) return;
    fi.dataset.mesUploadWired = '1';
    fi.addEventListener('change', function () {
      const file = fi.files?.[0];
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) {
        const err = document.getElementById('mes-upload-error');
        if (err) {
          err.style.display = 'block';
          err.textContent = 'Fichier trop volumineux (max 10 Mo).';
        }
        fi.value = '';
        return;
      }
      const err = document.getElementById('mes-upload-error');
      if (err) err.style.display = 'none';
      updateMesUploadFileLabel(file);
    });
  }

  function patchMesDocsHandlers() {
    wireMesUploadFileInput();

    if (window.__mesDocsHandlersV2) return;
    window.__mesDocsHandlersV2 = true;

    if (typeof renderMesDocs === 'function' && !window.__renderMesDocsOrig) {
      window.__renderMesDocsOrig = renderMesDocs;
    }

    window.renderMesDocs = function () {
      if (mesDocsApiReady) renderMesDocsLive();
      else if (typeof window.__renderMesDocsOrig === 'function') window.__renderMesDocsOrig();
    };

    window.downloadMesDoc = async function (id) {
      if (mesDocsApiReady && typeof api.downloadDocument === 'function') {
        try {
          await api.downloadDocument(id);
          if (typeof showToast === 'function') showToast('Téléchargement démarré ✓');
        } catch (err) {
          if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur');
        }
        return;
      }
      if (typeof showToast === 'function') showToast('Téléchargement…');
    };

    window.deleteMesDoc = async function (id) {
      const d = mesDocs.find(function (x) { return x.id === id; });
      if (!d || d.from !== 'Moi') return;
      if (!confirm('Supprimer « ' + d.name + ' » ?')) return;
      if (mesDocsApiReady && typeof api.deleteMyDocument === 'function') {
        try {
          await api.deleteMyDocument(id);
          await loadMesDocsPage();
          if (typeof showToast === 'function') showToast('Document supprimé ✓');
        } catch (err) {
          if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur');
        }
        return;
      }
      mesDocs = mesDocs.filter(function (x) { return x.id !== id; });
      renderMesDocs();
      if (typeof showToast === 'function') showToast('Document supprimé');
    };

    window.openMesDocsUpload = function () {
      resetMesUploadForm();
      wireMesUploadFileInput();
      const modal = document.getElementById('modal-mes-upload');
      if (modal) modal.classList.add('open');
      if (typeof loadMesDocsPage === 'function') loadMesDocsPage();
    };

    window.submitMesDocsUpload = async function () {
      const name = document.getElementById('mes-upload-name')?.value?.trim();
      const file = document.getElementById('mes-upload-file')?.files?.[0];
      const err = document.getElementById('mes-upload-error');
      if (!file) {
        if (err) { err.style.display = 'block'; err.textContent = 'Choisissez un fichier.'; }
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        if (err) { err.style.display = 'block'; err.textContent = 'Fichier trop volumineux (max 10 Mo).'; }
        return;
      }
      if (err) err.style.display = 'none';
      const btn = document.getElementById('mes-upload-submit-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
      try {
        if (typeof api === 'undefined' || typeof api.uploadMyDocument !== 'function') {
          throw { message: 'API non disponible — vérifiez que le backend est démarré.' };
        }
        await api.uploadMyDocument(file, name || file.name);
        if (typeof closeModal === 'function') closeModal('modal-mes-upload');
        else document.getElementById('modal-mes-upload')?.classList.remove('open');
        resetMesUploadForm();
        await loadMesDocsPage();
        if (typeof showToast === 'function') showToast('Document enregistré ✓');
      } catch (e) {
        if (err) {
          err.style.display = 'block';
          err.textContent = e.error || e.message || 'Erreur lors de l\'envoi';
        }
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enregistrer'; }
      }
    };
  }

  /* ─── Communication ──────────────────────────────────────── */

  let commApiLoaded = false;

  async function loadCommunicationPage() {
    if (typeof COMM_MSGS === 'undefined') return;

    try {
      const [{ channels }, msgRes] = await Promise.all([
        api.commChannels(),
        api.commMessages(typeof currentChan !== 'undefined' ? currentChan : 'general'),
      ]);

      if (typeof CHAN_META !== 'undefined') {
        channels.forEach(function (c) {
          CHAN_META[c.slug] = { label: c.label, desc: c.description };
        });
      }

      const slug = msgRes.channel?.slug || 'general';
      COMM_MSGS[slug] = (msgRes.messages || []).map(mapCommMessage);

      commApiLoaded = true;
      if (typeof renderChanFeed === 'function') renderChanFeed();
    } catch (err) {
      console.warn('Communication:', err.error || err.message);
      if (typeof renderChanFeed === 'function') renderChanFeed();
    }
  }

  function apiBase() {
    return (window.__PULSIIA_CONFIG__ && window.__PULSIIA_CONFIG__.apiUrl) || 'http://localhost:3001';
  }

  function formatCommMessageText(m) {
    var text = m.text || '';
    if (m.attachment && m.attachment.url) {
      var url = m.attachment.url.indexOf('http') === 0 ? m.attachment.url : apiBase() + m.attachment.url;
      var name = (m.attachment.name || 'Pièce jointe').replace(/'/g, "\\'");
      text += ' <a href="#" onclick="downloadCommFile(\'' + url.replace(/'/g, "\\'") + '\', \'' + name + '\'); return false;" style="color:var(--blue);font-size:12px">📎 ' + (m.attachment.name || 'Pièce jointe') + '</a>';
    }
    return text;
  }

  function mapCommMessage(m) {
    return {
      id: m.id,
      user: m.user,
      initials: m.initials,
      color: m.color,
      role: m.role,
      time: m.time,
      text: formatCommMessageText(m),
      pinned: m.pinned,
      reactions: m.reactions || { '👍': { count: 0, reacted: false } },
      replies: m.replies || [],
    };
  }

  async function downloadCommFile(url, name) {
    try {
      var headers = {};
      if (typeof Auth !== 'undefined' && Auth.accessToken) {
        headers.Authorization = 'Bearer ' + Auth.accessToken;
      }
      var response = await fetch(url, { headers: headers });
      if (!response.ok) throw new Error('Téléchargement impossible');
      var blob = await response.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name || 'piece-jointe';
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message || 'Erreur téléchargement');
    }
  }

  async function loadCommChannel(slug) {
    if (typeof COMM_MSGS === 'undefined') return;
    try {
      const res = await api.commMessages(slug);
      COMM_MSGS[slug] = (res.messages || []).map(mapCommMessage);
      if (typeof renderChanFeed === 'function') renderChanFeed();
    } catch (err) {
      console.warn('Canal:', err.error || err.message);
    }
  }

  /* ─── QCM — historique API ───────────────────────────────── */

  async function loadQcmHistoryFromApi() {
    if (typeof qcmHistory === 'undefined') return;
    try {
      const { history } = await api.myQcmHistory();
      if (!history || !history.length) return;
      history.slice(0, 7).forEach(function (h, i) {
        if (qcmHistory[i]) {
          qcmHistory[i] = { day: h.day || qcmHistory[i].day, score: h.score, done: true };
        }
      });
      if (typeof renderQCMHistory === 'function') renderQCMHistory();
    } catch (_e) { /* optional */ }
  }

  function bootstrapActivePageLoads() {
    var active = document.querySelector('.page.active');
    if (!active || !active.id || active.id.indexOf('page-') !== 0) return;
    var name = active.id.slice(5);
    if (name === 'collaborateurs') loadCollaborateursPage();
    else if (name === 'organigramme' && typeof loadOrganigrammePage === 'function') loadOrganigrammePage();
    else if (name === 'documents' && typeof loadDocumentsPage === 'function') loadDocumentsPage();
    else if (name === 'mes-docs' && typeof loadMesDocsPage === 'function') loadMesDocsPage();
    else if (name === 'communication' && typeof loadCommunicationPage === 'function') loadCommunicationPage();
    else if (name === 'mes-params' && typeof loadMesParamsPage === 'function') loadMesParamsPage();
    else if (name === 'planning' && typeof syncPlanningCollabsFromApi === 'function') syncPlanningCollabsFromApi();
    else if ((name === 'prepaie' || name === 'absences') && typeof loadAllSsCollabsFromApi === 'function') loadAllSsCollabsFromApi();
  }

  /* ─── Hooks showPage ─────────────────────────────────────── */

  function patchShowPage() {
    if (typeof window.showPage !== 'function' || window.showPage.__pagesApiPatched) return;
    const original = window.showPage;
    window.showPage = function (name, navEl) {
      original(name, navEl);
      if (name === 'organigramme') loadOrganigrammePage();
      if (name === 'documents') loadDocumentsPage();
      if (name === 'mes-docs') loadMesDocsPage();
      if (name === 'communication') loadCommunicationPage();
      if (name === 'mes-params') loadMesParamsPage();
      if (name === 'planning') syncPlanningCollabsFromApi();
      if (name === 'prepaie' || name === 'absences') loadAllSsCollabsFromApi();
    };
    window.showPage.__pagesApiPatched = true;
    window.__showPageReal = window.showPage;
  }

  function deferPatchShowPage() {
    if (typeof window.showPage === 'function' && typeof window.__showPageExtras === 'function') {
      patchShowPage();
    } else {
      setTimeout(deferPatchShowPage, 30);
    }
  }

  /* ─── Communication: envoi via API ───────────────────────── */

  function patchSendCommMsg() {
    if (typeof sendCommMsg !== 'function' || sendCommMsg.__pagesApiPatched) return;
    const original = sendCommMsg;
    window.sendCommMsg = async function () {
      const inp = document.getElementById('comm-input');
      const val = inp ? inp.value.trim() : '';
      const pendingFile = window.commPendingFile || null;
      if (!val && !pendingFile) return;

      if (commApiLoaded && typeof currentChan !== 'undefined') {
        try {
          await api.sendCommMessage(currentChan, val.replace(/</g, ''), null, pendingFile);
          window.commPendingFile = null;
          inp.value = '';
          await loadCommChannel(currentChan);
          if (typeof clearTyping === 'function') clearTyping();
          return;
        } catch (err) {
          if (typeof showToast === 'function') showToast(err.error || 'Erreur envoi message');
          return;
        }
      }
      original();
    };
    sendCommMsg.__pagesApiPatched = true;
  }

  function patchSwitchChan() {
    if (typeof switchChan !== 'function' || switchChan.__pagesApiPatched) return;
    const original = switchChan;
    window.switchChan = function (chan, el) {
      // S'assurer que le panneau idées est masqué quand on change de canal
      const ideaPanel = document.getElementById('ideabox-panel');
      const msgPanel  = document.getElementById('comm-messages-panel');
      if (ideaPanel) ideaPanel.style.display = 'none';
      if (msgPanel)  msgPanel.style.display  = '';
      original(chan, el);
      if (commApiLoaded) loadCommChannel(chan);
    };
    switchChan.__pagesApiPatched = true;
  }

  document.addEventListener('DOMContentLoaded', function () {
    deferPatchShowPage();
    patchSendCommMsg();
    patchSwitchChan();
    patchCollabGlobalSearch();
    patchDocumentsHandlers();
    patchMesDocsHandlers();
    patchSaveProfile();
    bootstrapActivePageLoads();
    setTimeout(loadAllSsCollabsFromApi, 500);
  }, { once: true });

  deferPatchShowPage();
  bootstrapActivePageLoads();
  patchDocumentsHandlers();
  patchSaveProfile();

  const paramsIbanInput = document.getElementById('params-iban');
  if (paramsIbanInput && !paramsIbanInput.__ibanPatched) {
    paramsIbanInput.addEventListener('input', function () {
      const pos = paramsIbanInput.selectionStart;
      const before = paramsIbanInput.value.length;
      paramsIbanInput.value = formatIbanInput(paramsIbanInput.value);
      const after = paramsIbanInput.value.length;
      const nextPos = Math.max(0, (pos || 0) + (after - before));
      paramsIbanInput.setSelectionRange(nextPos, nextPos);
    });
    paramsIbanInput.__ibanPatched = true;
  }

  window.collabCanEditHourlyRate = collabCanEditHourlyRate;
  window.loadCollaborateursPage = loadCollaborateursPage;
  window.onCollabFilterChange = onCollabFilterChange;
  window.debouncedCollabSearch = debouncedCollabSearch;
  window.openCollabModal = openCollabModal;
  window.openAddCollab = openAddCollab;
  window.submitAddCollab = submitAddCollab;
  window.collabStartEdit = collabStartEdit;
  window.saveCollabEdit = saveCollabEdit;
  window.collabGoPlanning = collabGoPlanning;
  window.collabCancelEdit = collabCancelEdit;
  window.openCollabCatalogModal = openCollabCatalogModal;
  window.addCollabJobPosition = addCollabJobPosition;
  window.addCollabPole = addCollabPole;
  window.deleteCollabJobPosition = deleteCollabJobPosition;
  window.deleteCollabPole = deleteCollabPole;
  window.collabJobSelectChange = collabJobSelectChange;
  window.collabContractChange = collabContractChange;
  window.exportCollabsCsv = exportCollabsCsv;
  window.collabChangePage = collabChangePage;
  window.collabChangeSort = collabChangeSort;
  window.deactivateCollab = deactivateCollab;
  window.reactivateCollab = reactivateCollab;
  window.addCollabSkill = addCollabSkill;
  window.deleteCollabSkill = deleteCollabSkill;
  window.addCollabSite = addCollabSite;
  window.uploadProfileAvatar = uploadProfileAvatar;
  window.importCollabsCsv = importCollabsCsv;
  window.resendCollabInvite = resendCollabInvite;
  window.resendAllCollabInvites = resendAllCollabInvites;
  window.downloadCommFile = downloadCommFile;
  window.syncPlanningCollabsFromApi = syncPlanningCollabsFromApi;
  window.loadCollabCatalog = loadCollabCatalog;
  window.getCollabCatalogPostes = getCollabCatalogPostes;
  window.getCollabCatalogPoles = getCollabCatalogPoles;
  window.clearPlanCollabFilter = function () {
    window.planCollabFilterApiUserId = null;
    if (typeof updatePlanFiltersUI === 'function') updatePlanFiltersUI();
    if (typeof renderPlanning === 'function') renderPlanning();
  };
  window.loadOrganigrammePage = loadOrganigrammePage;
  window.loadDocumentsPage = loadDocumentsPage;
  window.exportDocumentsCsv = exportDocumentsCsv;
  window.loadMesDocsPage = loadMesDocsPage;
  window.patchMesDocsHandlers = patchMesDocsHandlers;
  window.loadCommunicationPage = loadCommunicationPage;
})();
