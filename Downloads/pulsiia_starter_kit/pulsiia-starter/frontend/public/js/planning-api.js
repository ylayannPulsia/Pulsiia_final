// planning-api.js — Planning branché sur l'API (remplace le mock COLLABS)
(function () {
  'use strict';

  const planWeekLoaded = {};
  let planCollabsLoaded = false;
  let planLoadPromise = null;
  let origRenderPlanning = null;

  function apiShiftToLocal(type) {
    const map = {
      MATIN: 'matin', APREM: 'aprem', NUIT: 'nuit', OFF: 'off',
      ABSENT: 'absent', JOURNEE: 'journee',
    };
    return map[type] || 'off';
  }

  function inferLocalTypeFromTimes(start, end) {
    if (!start || !end) return 'journee';
    const sh = parseInt(start.split(':')[0], 10);
    const eh = parseInt(end.split(':')[0], 10);
    if (sh >= 22 || eh <= 6) return 'nuit';
    if (sh < 14) return 'matin';
    return 'aprem';
  }

  function apiShiftsToDayEntry(dayShifts) {
    if (!dayShifts || !dayShifts.length) return 'off';
    if (dayShifts.length === 1) {
      const sh = dayShifts[0];
      if (sh.type === 'ABSENT') return { custom: false, type: 'absent', note: sh.notes || '' };
      if (sh.type === 'OFF') return 'off';
      if (sh.type === 'JOURNEE' && sh.startTime && sh.endTime) {
        return {
          custom: true,
          start: sh.startTime,
          end: sh.endTime,
          breakStart: sh.breakStart || '',
          breakEnd: sh.breakEnd || '',
          breakMin: sh.breakMin != null ? sh.breakMin : 0,
          type: inferLocalTypeFromTimes(sh.startTime, sh.endTime),
          note: sh.notes || '',
        };
      }
      return { custom: false, type: apiShiftToLocal(sh.type), note: sh.notes || '' };
    }

    const segments = dayShifts
      .filter(function (sh) { return sh.type !== 'OFF' && sh.type !== 'ABSENT'; })
      .sort(function (a, b) { return (a.startTime || '').localeCompare(b.startTime || ''); })
      .map(function (sh) {
        const start = sh.startTime || '09:00';
        const end = sh.endTime || '17:00';
        return {
          start: start,
          end: end,
          breakStart: sh.breakStart || '',
          breakEnd: sh.breakEnd || '',
          breakMin: sh.breakMin != null ? sh.breakMin : 0,
          type: sh.type === 'JOURNEE' ? inferLocalTypeFromTimes(start, end) : apiShiftToLocal(sh.type),
        };
      });

    if (!segments.length) return 'off';
    if (segments.length === 1) {
      const seg = segments[0];
      return {
        custom: true,
        start: seg.start,
        end: seg.end,
        breakStart: seg.breakStart,
        breakEnd: seg.breakEnd,
        breakMin: seg.breakMin,
        type: seg.type,
        note: dayShifts[0].notes || '',
      };
    }

    return {
      custom: true,
      multi: true,
      segments: segments,
      note: dayShifts[0].notes || '',
    };
  }

  function localEntryToApiShifts(entry) {
    if (entry == null || entry === '') return [];
    if (typeof entry === 'string') {
      if (entry === 'empty' || entry === 'off') return [];
      const type = (typeof localShiftTypeToApi === 'function' ? localShiftTypeToApi(entry) : null)
        || { matin: 'MATIN', aprem: 'APREM', nuit: 'NUIT', absent: 'ABSENT', journee: 'JOURNEE' }[entry];
      return type && type !== 'OFF' ? [{ type: type, startTime: null, endTime: null }] : [];
    }
    if (entry.absenceType || entry.type === 'absent') {
      return [{ type: 'ABSENT', startTime: null, endTime: null }];
    }
    if (entry.multi && Array.isArray(entry.segments)) {
      return entry.segments.map(function (seg) {
        return {
          type: 'JOURNEE',
          startTime: seg.start,
          endTime: seg.end,
          breakStart: seg.breakStart || null,
          breakEnd: seg.breakEnd || null,
          breakMin: seg.breakMin != null ? seg.breakMin : null,
        };
      });
    }
    if (entry.custom && entry.start && entry.end) {
      return [{
        type: 'JOURNEE',
        startTime: entry.start,
        endTime: entry.end,
        breakStart: entry.breakStart || null,
        breakEnd: entry.breakEnd || null,
        breakMin: entry.breakMin != null ? entry.breakMin : null,
      }];
    }
    const type = (typeof localShiftTypeToApi === 'function' ? localShiftTypeToApi(entry.type) : null)
      || { matin: 'MATIN', aprem: 'APREM', nuit: 'NUIT', absent: 'ABSENT', journee: 'JOURNEE' }[entry.type];
    return type && type !== 'OFF' ? [{ type: type, startTime: null, endTime: null }] : [];
  }

  window.apiShiftsToDayEntry = apiShiftsToDayEntry;
  window.localEntryToApiShifts = localEntryToApiShifts;

  function deptFromUser(u) {
    const pole = (u.secondaryRoles && u.secondaryRoles[0]) || '';
    if (pole) return pole;
    const j = (u.jobTitle || '').toLowerCase();
    if (j.includes('cuisin') || j.includes('chef') || j.includes('pâtiss')) return 'Cuisine';
    if (j.includes('serve') || j.includes('sommelier') || j.includes('barman')) return 'Service';
    if (j.includes('accueil') || j.includes('hôte')) return 'Accueil';
    if (j.includes('directeur') || j.includes('rh') || u.role === 'DRH' || u.role === 'RH') return 'Direction';
    return 'Service';
  }

  function apiUserToCollab(u) {
    const dept = deptFromUser(u);
    const templates = window.PLANNING_SHIFT_TEMPLATES || {};
    const canShifts = ['matin', 'aprem'];
    if (!templates.NUIT || templates.NUIT.enabled !== false) canShifts.push('nuit');
    return {
      id: u.id,
      apiUserId: u.id,
      name: u.shortName || `${u.firstName} ${(u.lastName || '')[0] || ''}.`.trim(),
      site: u.siteName || u.site?.name || '—',
      siteId: u.siteId || u.site?.id || null,
      role: dept,
      poste: u.jobTitle || u.role,
      weeklyHours: u.weeklyHours || u.contractWeeklyHours || 35,
      contractWeeklyHours: u.contractWeeklyHours || u.weeklyHours || 35,
      maxWeeklyHoursLegal: u.maxWeeklyHoursLegal || 48,
      maxWeeklyHoursPlanning: u.maxWeeklyHoursPlanning || u.maxWeeklyHoursLegal || 48,
      competences: u.competences || [],
      secondaryRoles: u.secondaryRoles || [],
      canShifts: canShifts,
      color: u.avatarColor || '#6B7280',
      initials: u.initials || ((u.firstName || '')[0] || '') + ((u.lastName || '')[0] || ''),
      isActive: u.isActive !== false,
    };
  }

  async function loadCompanyPlanningConfig() {
    if (typeof api.companySettings !== 'function') return;
    try {
      const data = await api.companySettings();
      const rules = data?.settings?.planningRules || {};
      window._companyPlanningRules = rules;
      window.PLANNING_SHIFT_TEMPLATES = rules.shiftTemplates || {};
      const defaults = {
        MATIN: ['06:00', '14:00'],
        APREM: ['14:00', '22:00'],
        NUIT: ['22:00', '06:00'],
        JOURNEE: ['09:00', '18:00'],
      };
      const times = {};
      ['MATIN', 'APREM', 'NUIT', 'JOURNEE'].forEach(function (key) {
        const tpl = rules.shiftTemplates?.[key];
        if (tpl && tpl.enabled === false) return;
        if (tpl?.start && tpl?.end) times[key] = [tpl.start, tpl.end];
        else if (defaults[key]) times[key] = defaults[key];
      });
      window.PLAN_SHIFT_DEFAULT_TIMES = times;
      if (typeof window.refreshShiftTypeButtons === 'function') window.refreshShiftTypeButtons();
    } catch (_e) { /* optional */ }
  }

  function isManagerPlanningScoped() {
    const role = window.Auth?.user?.role || window.currentUser?.role;
    return role === 'MANAGER' || window._planManagerScoped === true;
  }

  function getManagerSiteName() {
    if (window._managerPlanSiteName) return window._managerPlanSiteName;
    const u = window.Auth?.user || window.currentUser;
    return u?.site?.name || null;
  }

  function applyManagerPlanningScope(user) {
    if (!user || user.role !== 'MANAGER') {
      window._planManagerScoped = false;
      window._managerPlanSiteId = null;
      window._managerPlanSiteName = null;
      const sel = document.getElementById('plan-site-select');
      if (sel) {
        sel.disabled = false;
        sel.title = 'Filtrer le planning par établissement';
      }
      const hint = document.getElementById('plan-manager-scope-hint');
      if (hint) hint.remove();
      return;
    }

    window._planManagerScoped = true;
    window._managerPlanSiteId = user.siteId || null;
    const siteName = user.site?.name;
    if (siteName) {
      window._managerPlanSiteName = siteName;
      if (typeof planSiteFilter !== 'undefined') planSiteFilter = siteName;
    }

    const sel = document.getElementById('plan-site-select');
    if (sel) {
      sel.disabled = true;
      sel.title = 'Votre établissement — planning limité à votre équipe';
    }

    const label = sel?.closest('label');
    if (label && !document.getElementById('plan-manager-scope-hint')) {
      const hint = document.createElement('span');
      hint.id = 'plan-manager-scope-hint';
      hint.style.cssText = 'font-size:11px;color:var(--text-2);white-space:nowrap';
      hint.textContent = '· votre équipe';
      label.appendChild(hint);
    }
  }

  function lockManagerSiteFilterFromApi(sites) {
    if (!isManagerPlanningScoped()) return;
    const siteName = getManagerSiteName()
      || (sites && sites[0] && sites[0].name)
      || (window.COLLABS && window.COLLABS[0] && window.COLLABS[0].site);
    if (siteName && typeof planSiteFilter !== 'undefined') {
      window._managerPlanSiteName = siteName;
      planSiteFilter = siteName;
    }
    populatePlanSiteSelect(sites || []);
  }

  function populatePlanSiteSelect(sites) {
    const sel = document.getElementById('plan-site-select');
    if (!sel) return;

    if (isManagerPlanningScoped()) {
      const siteName = getManagerSiteName()
        || (sites && sites[0] && sites[0].name)
        || 'Mon établissement';
      window._managerPlanSiteName = siteName;
      if (typeof planSiteFilter !== 'undefined') planSiteFilter = siteName;
      sel.innerHTML = `<option value="${siteName.replace(/"/g, '&quot;')}">${siteName.replace(/</g, '&lt;')}</option>`;
      sel.value = siteName;
      sel.disabled = true;
      return;
    }

    const current = typeof planSiteFilter !== 'undefined' ? planSiteFilter : 'Tous';
    const names = (sites || []).map(function (s) { return s.name; }).filter(Boolean);
    sel.innerHTML = '<option value="Tous">Tous les sites</option>'
      + names.map(function (n) {
        return `<option value="${n.replace(/"/g, '&quot;')}">${n}</option>`;
      }).join('');
    if (current && (current === 'Tous' || names.indexOf(current) >= 0)) {
      sel.value = current;
    }
  }

  function updatePlanCollabFilterBanner() {
    if (typeof updatePlanFiltersUI === 'function') updatePlanFiltersUI();
  }

  async function loadPlanningCollabsFromApi(force) {
    if (planCollabsLoaded && !force) return;
    if (typeof api === 'undefined' || typeof api.users !== 'function') return;

    // Un COLLABORATEUR n'a pas accès à /api/users (403). On initialise COLLABS
    // avec son propre profil pour que le planning puisse s'afficher.
    const currentRole = (window.Auth?.user?.role || window.currentUser?.role || '');
    if (currentRole === 'COLLABORATEUR') {
      const u = window.Auth?.user || window.currentUser;
      if (u) {
        window.planUsersCache = [u];
        window.planSitesCache = u.site ? [u.site] : [];
        window.COLLABS = [apiUserToCollab(u)];
        COLLABS = window.COLLABS;
        window.MON_PLAN_COLLAB_ID = u.id;
        planCollabsLoaded = true;
      }
      return;
    }

    const res = await api.users({ limit: 100, sort: 'lastName' });
    const users = (res.users || []).filter(function (u) { return u.isActive !== false; });
    window.planUsersCache = users;
    window.planSitesCache = res.sites || [];
    window.COLLABS = users.filter(function (u) { return u.isActive !== false; }).map(apiUserToCollab);
    COLLABS = window.COLLABS;
    lockManagerSiteFilterFromApi(res.sites || []);
    planCollabsLoaded = true;

    if (typeof SS_DATA !== 'undefined' && users.length) {
      const ssItems = users.filter(function (u) { return u.isActive !== false; }).map(function (u) {
        return {
          value: u.id,
          label: u.shortName || ((u.firstName || '') + ' ' + ((u.lastName || '')[0] || '') + '.').trim(),
          site: u.siteName || u.site?.name || '',
          color: u.avatarColor || '#6B7280',
          init: u.initials || ((u.firstName || '')[0] || '') + ((u.lastName || '')[0] || ''),
        };
      });
      SS_DATA['shift-collab'] = ssItems;
      if (typeof ssRenderList === 'function') ssRenderList('shift-collab', '');
    }

    if (typeof Auth !== 'undefined' && Auth.user && Auth.user.id) {
      window.MON_PLAN_COLLAB_ID = Auth.user.id;
    } else if (window.COLLABS.length) {
      window.MON_PLAN_COLLAB_ID = window.COLLABS[0].id;
    }
  }

  async function loadPlanningWeekFromApi(offset, force) {
    if (planWeekLoaded[offset] && !force) return;
    if (typeof getWeekDates !== 'function' || typeof formatPlanISODate !== 'function') return;
    if (typeof api === 'undefined' || typeof api.planningWeekAll !== 'function') return;

    // Pour un COLLABORATEUR, api.users() retourne 403 → on isole l'erreur
    // pour ne pas bloquer le chargement des shifts via planningWeekAll.
    try {
      await loadPlanningCollabsFromApi(false);
    } catch (collabErr) {
      console.warn('[planning-api] collabs load skipped (403 expected for COLLABORATEUR):', collabErr.status || collabErr.message);
      // Initialiser MON_PLAN_COLLAB_ID dès maintenant pour que renderMonPlanning fonctionne
      if (typeof Auth !== 'undefined' && Auth.user && Auth.user.id) {
        window.MON_PLAN_COLLAB_ID = Auth.user.id;
      }
    }

    try {
    const dates = getWeekDates(offset);
    const from = formatPlanISODate(dates[0]);
    const res = await api.planningWeekAll(from);

    if (typeof ensureWeekSchedule === 'function') ensureWeekSchedule(offset);
    else if (!scheduleData[offset]) scheduleData[offset] = {};

    (COLLABS || []).forEach(function (c) {
      scheduleData[offset][c.id] = ['off', 'off', 'off', 'off', 'off', 'off', 'off'];
    });

    (res.users || []).forEach(function (u) {
      if (!scheduleData[offset][u.id]) {
        scheduleData[offset][u.id] = ['off', 'off', 'off', 'off', 'off', 'off', 'off'];
      }
      const byDay = {};
      (u.shifts || []).forEach(function (sh) {
        const dayIdx = dates.findIndex(function (d) { return formatPlanISODate(d) === sh.date; });
        if (dayIdx < 0) return;
        if (!byDay[dayIdx]) byDay[dayIdx] = [];
        byDay[dayIdx].push(sh);
      });
      Object.keys(byDay).forEach(function (dayKey) {
        scheduleData[offset][u.id][Number(dayKey)] = apiShiftsToDayEntry(byDay[dayKey]);
      });
    });

    if (typeof cloneWeekScheduleData === 'function' && typeof planPublishedSnapshots !== 'undefined') {
      planPublishedSnapshots[offset] = {
        data: cloneWeekScheduleData(scheduleData[offset]),
        publishedAt: new Date().toISOString(),
        weekLabel: typeof formatWeekRange === 'function' ? formatWeekRange(offset) : from,
      };
      if (typeof savePlanPublishedSnapshots === 'function') savePlanPublishedSnapshots();
    }

    planWeekLoaded[offset] = true;

    if (typeof generateAISuggestions === 'function') generateAISuggestions();
    } catch (err) {
      console.warn('[planning-api] week load:', err.error || err.message || err);
      planWeekLoaded[offset] = true;
      if (typeof Auth !== 'undefined' && Auth.user && Auth.user.id) {
        window.MON_PLAN_COLLAB_ID = Auth.user.id;
      }
    }
  }

  async function ensurePlanningApiReady(forceWeek) {
    const offset = typeof planWeekOffset !== 'undefined' ? planWeekOffset : 0;
    const mustReload = !!forceWeek;

    if (planLoadPromise && !mustReload) {
      return planLoadPromise;
    }

    const load = (async function () {
      await loadCompanyPlanningConfig();
      await loadPlanningCollabsFromApi(mustReload);
      await loadPlanningWeekFromApi(offset, mustReload);
    })();

    planLoadPromise = load;

    try {
      await load;
    } catch (err) {
      console.warn('[planning-api] load:', err.error || err.message || err);
      throw err;
    } finally {
      if (planLoadPromise === load) {
        planLoadPromise = null;
      }
    }
  }

  function safeRenderPlanning() {
    if (!origRenderPlanning) return;
    try {
      origRenderPlanning();
    } catch (err) {
      console.warn('[planning-api] render:', err.message || err);
    }
  }

  function refreshPlanningAfterApi(forceWeek) {
    return ensurePlanningApiReady(forceWeek).then(function () {
      if (typeof updatePlanCollabFilterBanner === 'function') updatePlanCollabFilterBanner();
      safeRenderPlanning();
    }).catch(function (err) {
      console.warn('[planning-api]', err.error || err.message || err);
      safeRenderPlanning();
    });
  }

  function patchResolveApiUserForCollab() {
    window.resolveApiUserForCollab = function (collabId) {
      if (!window.planUsersCache || !window.planUsersCache.length) return null;
      return window.planUsersCache.find(function (u) { return u.id === collabId; }) || null;
    };
  }

  function patchBuildPublishWeekPayload() {
    window.buildPublishWeekPayload = function (offset, weekData) {
      const dates = getWeekDates(offset);
      const from = formatPlanISODate(dates[0]);
      const userIds = [];
      const shifts = [];
      const skippedNoSite = [];

      const fallbackSiteId = (window.planSitesCache || [])[0]?.id || null;

      (COLLABS || []).forEach(function (collab) {
        const user = resolveApiUserForCollab(collab.id);
        if (!user) return;
        const siteId = user.siteId || user.site?.id || collab.siteId || fallbackSiteId;
        if (!siteId) {
          skippedNoSite.push(collab.name || collab.id);
          return;
        }
        userIds.push(user.id);

        const row = weekData[collab.id] || [];
        for (let i = 0; i < 7; i++) {
          const apiShifts = localEntryToApiShifts(row[i]);
          apiShifts.forEach(function (apiShift) {
            if (!apiShift || apiShift.type === 'OFF') return;
            const times = (window.PLAN_SHIFT_DEFAULT_TIMES || {})[apiShift.type];
            shifts.push({
              userId: user.id,
              siteId: siteId,
              date: formatPlanISODate(dates[i]),
              type: apiShift.type,
              startTime: apiShift.startTime || (times ? times[0] : null),
              endTime: apiShift.endTime || (times ? times[1] : null),
              breakStart: apiShift.breakStart || null,
              breakEnd: apiShift.breakEnd || null,
              breakMin: apiShift.breakMin != null ? apiShift.breakMin : null,
            });
          });
        }
      });

      if (skippedNoSite.length) {
        console.warn('[planning] Collaborateurs ignorés (aucun établissement) :', skippedNoSite.join(', '));
        window._planPublishSkippedNoSite = skippedNoSite;
      } else {
        window._planPublishSkippedNoSite = null;
      }

      return { from: from, userIds: [...new Set(userIds)], shifts: shifts };
    };
  }

  function patchRenderPlanning() {
    if (typeof renderPlanning !== 'function' || renderPlanning.__planApiPatched) return;
    origRenderPlanning = renderPlanning;
    window.renderPlanning = function () {
      // Ne pas bloquer l'UI sur « Chargement… » — afficher tout de suite, puis rafraîchir via l'API.
      safeRenderPlanning();
      refreshPlanningAfterApi(false);
    };
    window.renderPlanning.__planApiPatched = true;
    window.renderPlanningImmediate = safeRenderPlanning;
  }

  function patchPlanChangeWeek() {
    if (typeof planChangeWeek !== 'function' || planChangeWeek.__planApiPatched) return;
    const orig = planChangeWeek;
    window.planChangeWeek = function (dir) {
      orig(dir);
      const offset = planWeekOffset;
      refreshPlanningAfterApi(true);
    };
    planChangeWeek.__planApiPatched = true;
  }

  function patchShowPagePlanning() {
    if (typeof showPage !== 'function' || showPage.__planApiShowPatched) return;
    const orig = showPage;
    window.showPage = function (name, navEl) {
      if (name === 'planning') {
        // Ne recharger depuis l'API que s'il n'y a pas de modifications locales non publiées
        const hasDraft = typeof isWeekDirty === 'function' && isWeekDirty(planWeekOffset);
        if (!hasDraft) {
          planCollabsLoaded = false;
          planWeekLoaded[planWeekOffset] = false;
        }
      }
      orig(name, navEl);
      if (name === 'accueil-collab' && typeof ensurePlanningApiReady === 'function') {
        ensurePlanningApiReady(false).then(function () {
          if (typeof renderAccueilWorkDays === 'function') renderAccueilWorkDays();
        }).catch(function () {
          if (typeof renderAccueilWorkDays === 'function') renderAccueilWorkDays();
        });
      }
    };
    showPage.__planApiShowPatched = true;
  }

  function patchClearPlanCollabFilter() {
    window.clearPlanCollabFilter = function () {
      window.planCollabFilterApiUserId = null;
      if (typeof updatePlanFiltersUI === 'function') updatePlanFiltersUI();
      if (origRenderPlanning) origRenderPlanning();
      else if (typeof renderPlanning === 'function') renderPlanning();
    };
    window.clearAllPlanFilters = window.clearAllPlanFilters || function () {
      if (typeof planSearchFilter !== 'undefined') planSearchFilter = '';
      if (!isManagerPlanningScoped() && typeof planSiteFilter !== 'undefined') planSiteFilter = 'Tous';
      else if (isManagerPlanningScoped() && typeof planSiteFilter !== 'undefined') {
        planSiteFilter = getManagerSiteName() || planSiteFilter;
      }
      window.planCollabFilterApiUserId = null;
      const inp = document.getElementById('plan-search');
      if (inp) inp.value = '';
      const sel = document.getElementById('plan-site-select');
      if (sel && !isManagerPlanningScoped()) sel.value = 'Tous';
      else if (sel && isManagerPlanningScoped()) sel.value = getManagerSiteName() || sel.value;
      if (origRenderPlanning) origRenderPlanning();
      else if (typeof renderPlanning === 'function') renderPlanning();
    };
  }

  function patchManagerPlanSiteControls() {
    if (typeof setPlanSite === 'function' && !setPlanSite.__planScopePatched) {
      const origSet = setPlanSite;
      window.setPlanSite = function (site) {
        if (isManagerPlanningScoped()) {
          const locked = getManagerSiteName();
          if (locked) site = locked;
        }
        return origSet(site);
      };
      setPlanSite.__planScopePatched = true;
    }

    if (typeof clearPlanSiteFilter === 'function' && !clearPlanSiteFilter.__planScopePatched) {
      const origClear = clearPlanSiteFilter;
      window.clearPlanSiteFilter = function () {
        if (isManagerPlanningScoped()) {
          if (typeof planSiteFilter !== 'undefined') planSiteFilter = getManagerSiteName() || planSiteFilter;
          if (origRenderPlanning) origRenderPlanning();
          else if (typeof renderPlanning === 'function') renderPlanning();
          return;
        }
        return origClear();
      };
      clearPlanSiteFilter.__planScopePatched = true;
    }

    if (typeof clearAllPlanFilters === 'function' && !clearAllPlanFilters.__planScopePatched) {
      const origClearAll = clearAllPlanFilters;
      window.clearAllPlanFilters = function () {
        const lockedSite = isManagerPlanningScoped() ? getManagerSiteName() : null;
        origClearAll();
        if (lockedSite && typeof planSiteFilter !== 'undefined') planSiteFilter = lockedSite;
        const sel = document.getElementById('plan-site-select');
        if (sel && lockedSite) sel.value = lockedSite;
      };
      clearAllPlanFilters.__planScopePatched = true;
    }
  }

  function patchApplyAuthenticatedSessionForPlanning() {
    if (typeof applyAuthenticatedSession !== 'function' || applyAuthenticatedSession.__planScopePatched) return;
    const orig = applyAuthenticatedSession;
    window.applyAuthenticatedSession = function (user) {
      orig(user);
      applyManagerPlanningScope(user);
      if (user && user.role === 'MANAGER') {
        planCollabsLoaded = false;
        Object.keys(planWeekLoaded).forEach(function (k) { delete planWeekLoaded[k]; });
      }
    };
    applyAuthenticatedSession.__planScopePatched = true;
  }

  function patchOpenShiftModalForApiCollabs() {
    if (typeof openShiftModal !== 'function' || openShiftModal.__apiCollabPatched) return;
    const origOpen = openShiftModal;
    window.openShiftModal = async function (collabId, dayIdx) {
      await loadPlanningCollabsFromApi(false);
      if (typeof SS_DATA !== 'undefined' && window.planUsersCache && window.planUsersCache.length) {
        const ssItems = window.planUsersCache
          .filter(function (u) { return u.isActive !== false; })
          .map(function (u) {
            return {
              value: u.id,
              label: u.shortName || ((u.firstName || '') + ' ' + ((u.lastName || '')[0] || '') + '.').trim(),
              site: u.siteName || (u.site && u.site.name) || '',
              color: u.avatarColor || '#6B7280',
              init: u.initials || ((u.firstName || '')[0] || '') + ((u.lastName || '')[0] || ''),
            };
          });
        SS_DATA['shift-collab'] = ssItems;
      }
      return origOpen(collabId, dayIdx);
    };
    window.openShiftModal.__apiCollabPatched = true;
  }

  function deferInit() {
    if (typeof renderPlanning !== 'function' || typeof getWeekDates !== 'function') {
      setTimeout(deferInit, 40);
      return;
    }
    patchResolveApiUserForCollab();
    patchBuildPublishWeekPayload();
    patchRenderPlanning();
    patchPlanChangeWeek();
    patchShowPagePlanning();
    patchClearPlanCollabFilter();
    patchManagerPlanSiteControls();
    patchApplyAuthenticatedSessionForPlanning();
    patchOpenShiftModalForApiCollabs();
    if (window.Auth?.user || window.currentUser) {
      applyManagerPlanningScope(window.Auth?.user || window.currentUser);
    }
  }

  window.invalidatePlanningCache = function () {
    planCollabsLoaded = false;
    Object.keys(planWeekLoaded).forEach(function (k) { delete planWeekLoaded[k]; });
  };

  window.loadPlanningCollabsFromApi = loadPlanningCollabsFromApi;
  window.loadPlanningWeekFromApi = loadPlanningWeekFromApi;
  window.ensurePlanningApiReady = ensurePlanningApiReady;
  window.applyManagerPlanningScope = applyManagerPlanningScope;
  window.isManagerPlanningScoped = isManagerPlanningScoped;
  window.isPlanWeekLoadedFromApi = function (offset) {
    return !!planWeekLoaded[offset];
  };

  deferInit();
})();
