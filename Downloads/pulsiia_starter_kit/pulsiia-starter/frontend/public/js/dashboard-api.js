// Connexion du dashboard maquette ↔ API /api/dashboard/*
(function () {
  const LOGIN_PATH = '/';
  const DASHBOARD_PATH = '/dashboard';
  const REFRESH_INTERVAL_MS = 60000;
  let refreshTimer = null;
  let loading = false;
  let lastKpiErrorToastAt = 0;

  function isLoginPage() {
    const path = window.location.pathname;
    return path === '/' || path.endsWith('/login.html');
  }

  if (!window.Auth?.isAuthenticated() && !isLoginPage()) {
    const next = encodeURIComponent(
      window.location.pathname === '/' ? DASHBOARD_PATH : window.location.pathname + window.location.search,
    );
    window.location.replace(`${LOGIN_PATH}?next=${next}`);
    return;
  }

  function ensureLoadingStyles() {
    if (document.getElementById('dash-api-styles')) return;
    const style = document.createElement('style');
    style.id = 'dash-api-styles';
    style.textContent = `
      .dash-kpi-skeleton {
        color: transparent !important;
        user-select: none;
        pointer-events: none;
        position: relative;
      }
      .dash-kpi-skeleton::after {
        content: '';
        position: absolute;
        inset: 2px 0;
        border-radius: 6px;
        background: #E2E8F0;
        animation: pulse 1.2s ease-in-out infinite;
      }
      .dash-kpi-error { color: #991B1B !important; }
      #dash-strategic-kpis.dash-kpi-skeleton .kpi-value::after {
        min-height: 28px;
        width: 72%;
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function userInitials(name) {
    return name.split(/\s+/).filter(Boolean).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  }

  function formatPeriod(period) {
    if (!period) return '';
    if (window.PeriodUtils) return PeriodUtils.periodLabel(period);
    if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
      const start = new Date(period + 'T12:00:00');
      const end = new Date(start);
      end.setDate(end.getDate() + 6);
      return 'Semaine du ' + start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
        + ' au ' + end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    if (!/^\d{4}-\d{2}$/.test(period)) return '';
    const [y, m] = period.split('-').map(Number);
    const label = new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function formatRelativeTime(iso) {
    const date = new Date(iso);
    const diffMs = Date.now() - date.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'à l\'instant';
    if (diffMin < 60) return `il y a ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `il y a ${diffH} h`;
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return 'Hier ' + date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    if (diffD < 7) return `il y a ${diffD} j`;
    return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function formatEuros(n) {
    return Math.round(n).toLocaleString('fr-FR') + '€';
  }

  function errorMessage(err) {
    if (err?.offline || err?.status === 0) return 'Connexion impossible (hors ligne ou serveur arrêté)';
    if (err?.status === 401) return 'Session expirée';
    if (err?.status === 403) return 'Accès refusé';
    if (err?.status >= 500) return 'Erreur serveur — réessayez plus tard';
    return err?.message || err?.error || 'Erreur de chargement';
  }

  function showFriendlyKpiError(err) {
    if (typeof showToast !== 'function') return;
    const now = Date.now();
    if (now - lastKpiErrorToastAt < 8000) return;
    lastKpiErrorToastAt = now;

    if (err?.offline || err?.status === 0) {
      showToast('😴 Pas de connexion — vos indicateurs reviendront dès que le réseau sera rétabli');
      return;
    }
    showToast('⚠️ ' + errorMessage(err));
  }

  function absenteeismRate(k) {
    if (!k.activeUsers) return null;
    return Math.round((k.pendingAbsences / k.activeUsers) * 1000) / 10;
  }

  function renderRoiFromReport(roi, k) {
    if (!roi?.current) return;

    const c = roi.current;
    const periodLabel = formatPeriod(roi.period || k?.period);
    const expl = c.coveredEmployees
      ? `${c.coveredEmployees} collab. couverts · ${c.errorsAvoided} contrôle${c.errorsAvoided > 1 ? 's' : ''} paie · sync planning sans ressaisie manuelle.`
      : `${c.errorsAvoided} anomalie${c.errorsAvoided > 1 ? 's' : ''} détectée${c.errorsAvoided > 1 ? 's' : ''} · variables auto validées sans ressaisie.`;

    const periodEl = document.getElementById('roi-period-label');
    if (periodEl) {
      periodEl.textContent = periodLabel ? `Ce mois-ci · ${periodLabel}` : 'Ce mois-ci';
    }

    ['roi-euros', 'rh-roi-euros'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = formatEuros(c.eurosSaved);
    });

    ['roi-heures', 'rh-roi-heures'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = c.rhHoursDisplay || `${c.rhHoursSaved}h`;
    });

    ['roi-erreurs', 'rh-roi-erreurs'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = String(c.errorsAvoided);
    });

    const explMain = document.getElementById('roi-explication');
    if (explMain) explMain.textContent = expl;

    const explRh = document.getElementById('rh-roi-explication');
    if (explRh) explRh.textContent = expl;
  }

  const KPI_VALUE_IDS = [
    'kpi-actifs-value',
    'kpi-absenteisme-value',
    'kpi-turnover-value',
    'kpi-wellbeing-value',
    'kpi-prepaie-value',
    'kpi-absences-value',
    'rh-kpi-effectif',
    'rh-kpi-absenteisme',
    'rh-kpi-turnover',
    'rh-kpi-wellbeing',
    'roi-euros',
    'roi-heures',
    'roi-erreurs',
    'rh-roi-euros',
    'rh-roi-heures',
    'rh-roi-erreurs',
  ];

  const KPI_META_IDS = [
    'kpi-actifs-delta',
    'kpi-absenteisme-delta',
    'kpi-turnover-delta',
    'kpi-wellbeing-delta',
    'kpi-prepaie-badge',
    'kpi-prepaie-sub',
    'kpi-absences-badge',
    'kpi-absences-sub',
    'rh-kpi-actifs-delta',
    'rh-kpi-absenteisme-delta',
    'rh-kpi-turnover-delta',
    'rh-kpi-wellbeing-delta',
    'dash-flux-prepaie-title',
    'roi-period-label',
    'roi-explication',
    'rh-roi-explication',
  ];

  function setKpiLoading(on) {
    ensureLoadingStyles();

    const grid = document.getElementById('dash-strategic-kpis');
    if (grid) grid.classList.toggle('dash-kpi-skeleton', on);

    KPI_VALUE_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (on) {
        if (!el.dataset.dashPrevHtml) el.dataset.dashPrevHtml = el.innerHTML;
        el.classList.add('dash-kpi-skeleton');
        if (id.includes('roi') || id.includes('rh-roi')) {
          el.textContent = '—';
        } else if (id.startsWith('rh-kpi')) {
          el.innerHTML = '—<sup>' + (id.includes('wellbeing') ? ' /10' : id.includes('absenteisme') || id.includes('turnover') ? ' %' : ' sal.') + '</sup>';
        } else if (id === 'kpi-actifs-value') {
          el.textContent = '—';
        } else if (id.includes('wellbeing')) {
          el.innerHTML = '—<span> /10</span>';
        } else if (id.includes('turnover') || id.includes('absenteisme')) {
          el.innerHTML = '—<span> %</span>';
        } else {
          el.textContent = '—';
        }
      } else {
        el.classList.remove('dash-kpi-skeleton');
        delete el.dataset.dashPrevHtml;
      }
    });

    KPI_META_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (on) {
        el.classList.add('dash-kpi-skeleton');
        if (id.includes('badge')) el.textContent = '…';
        else if (id === 'dash-flux-prepaie-title') el.textContent = 'Clôture pré-paie — chargement…';
      } else {
        el.classList.remove('dash-kpi-skeleton', 'dash-kpi-error');
      }
    });
  }

  function setDelta(el, text, variant) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('up', 'down', 'neutral');
    if (variant) el.classList.add(variant);
  }

  function renderStrategicKpis(k) {
    const absRate = absenteeismRate(k);
    const periodLabel = formatPeriod(k.period);

    const actifsVal = document.getElementById('kpi-actifs-value');
    if (actifsVal) actifsVal.textContent = String(k.activeUsers);
    setDelta(
      document.getElementById('kpi-actifs-delta'),
      periodLabel ? `${periodLabel} · temps réel` : 'Effectif synchronisé',
      'neutral'
    );

    const absVal = document.getElementById('kpi-absenteisme-value');
    if (absVal) {
      absVal.innerHTML = absRate != null
        ? `${absRate}<span> %</span>`
        : '—<span> %</span>';
    }
    setDelta(
      document.getElementById('kpi-absenteisme-delta'),
      k.pendingAbsences
        ? `${k.pendingAbsences} demande${k.pendingAbsences > 1 ? 's' : ''} en attente`
        : 'Aucune demande en attente',
      k.pendingAbsences ? 'down' : 'up'
    );

    const turnoverVal = document.getElementById('kpi-turnover-value');
    if (turnoverVal) turnoverVal.innerHTML = '—<span> %</span>';

    const wbVal = document.getElementById('kpi-wellbeing-value');
    if (wbVal) {
      const score = k.wellbeingScore != null ? k.wellbeingScore : '—';
      wbVal.innerHTML = `${score}<span> /10</span>`;
    }
    setDelta(
      document.getElementById('kpi-wellbeing-delta'),
      k.participationRate != null
        ? `${k.participationRate}% de participation QCM`
        : 'Moyenne enquêtes actives',
      k.wellbeingScore != null && k.wellbeingScore < 6 ? 'down' : 'up'
    );

    const rhEffectif = document.getElementById('rh-kpi-effectif');
    if (rhEffectif) rhEffectif.innerHTML = `${k.activeUsers}<sup> sal.</sup>`;
    setDelta(
      document.getElementById('rh-kpi-actifs-delta'),
      periodLabel ? `${periodLabel} · API` : 'API · temps réel',
      'neutral'
    );

    const rhAbs = document.getElementById('rh-kpi-absenteisme');
    if (rhAbs) {
      rhAbs.innerHTML = absRate != null ? `${absRate}<sup> %</sup>` : '—<sup> %</sup>';
    }
    setDelta(
      document.getElementById('rh-kpi-absenteisme-delta'),
      k.pendingAbsences ? `${k.pendingAbsences} en attente` : 'Sous contrôle',
      k.pendingAbsences ? 'down' : 'up'
    );

    const rhTurnover = document.getElementById('rh-kpi-turnover');
    if (rhTurnover) rhTurnover.innerHTML = '—<sup> %</sup>';

    const rhWellbeing = document.getElementById('rh-kpi-wellbeing');
    if (rhWellbeing) {
      const score = k.wellbeingScore != null ? k.wellbeingScore : '—';
      rhWellbeing.innerHTML = `${score}<sup> /10</sup>`;
    }
    setDelta(
      document.getElementById('rh-kpi-wellbeing-delta'),
      k.participationRate != null ? `${k.participationRate}% participation` : 'Moyenne enquêtes',
      'neutral'
    );

    const wbDot   = document.getElementById('dash-flux-wb-dot');
    const wbTitle = document.getElementById('dash-flux-wb-title');
    const wbSub   = document.getElementById('dash-flux-wb-sub');
    const wbBadge = document.getElementById('dash-flux-wb-badge');
    if (wbTitle && k.wellbeingScore != null) {
      const s = k.wellbeingScore;
      const scoreLabel = `${s}/10`;
      const part = k.participationRate != null ? ` · ${k.participationRate}% de participation` : '';
      if (s < 6) {
        if (wbDot)   wbDot.style.background = '#DC2626';
        wbTitle.textContent = `Score bien-être en alerte — ${scoreLabel}`;
        if (wbSub)   wbSub.textContent = `Score global${part}`;
        if (wbBadge) { wbBadge.textContent = '⚠ Alerte'; wbBadge.style.cssText = 'font-size:11px;font-weight:600;background:#FEF2F2;color:#DC2626;padding:3px 9px;border-radius:20px;border:1px solid #FECACA;flex-shrink:0'; }
      } else if (s < 7.5) {
        if (wbDot)   wbDot.style.background = '#D97706';
        wbTitle.textContent = `Score bien-être à surveiller — ${scoreLabel}`;
        if (wbSub)   wbSub.textContent = `Score global${part}`;
        if (wbBadge) { wbBadge.textContent = '⚠ Surveiller'; wbBadge.style.cssText = 'font-size:11px;font-weight:600;background:#FFFBEB;color:#D97706;padding:3px 9px;border-radius:20px;border:1px solid #FDE68A;flex-shrink:0'; }
      } else {
        if (wbDot)   wbDot.style.background = 'var(--green)';
        wbTitle.textContent = `Score bien-être satisfaisant — ${scoreLabel}`;
        if (wbSub)   wbSub.textContent = `Score global${part}`;
        if (wbBadge) { wbBadge.textContent = '✓ Bon'; wbBadge.style.cssText = 'font-size:11px;font-weight:600;background:var(--green-bg);color:var(--green);padding:3px 9px;border-radius:20px;border:1px solid #A7F3D0;flex-shrink:0'; }
      }
    }
  }

  function renderRoiFromKpis(k) {
    if (window._lastRoiReport?.current) {
      renderRoiFromReport(window._lastRoiReport, k);
    }
  }

  function showKpiError(err) {
    ensureLoadingStyles();
    const msg = errorMessage(err);

    ['kpi-actifs-value', 'kpi-prepaie-value', 'kpi-absences-value'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove('dash-kpi-skeleton');
        el.classList.add('dash-kpi-error');
        el.textContent = '—';
      }
    });

    const sub = document.getElementById('kpi-prepaie-sub');
    if (sub) {
      sub.classList.add('dash-kpi-error');
      sub.textContent = msg;
    }

    const flux = document.getElementById('dash-flux-prepaie-title');
    if (flux) {
      flux.classList.add('dash-kpi-error');
      flux.textContent = 'Indicateurs indisponibles';
    }
  }

  function activitySkeleton() {
    return [1, 2, 3].map(() =>
      `<div class="activity-item" style="padding:10px 20px;opacity:.5">
        <div class="activity-avatar" style="background:#E2E8F0;width:32px;height:32px;border-radius:50%;animation:pulse 1.2s ease-in-out infinite"></div>
        <div class="activity-text" style="flex:1;height:32px;background:#F1F5F9;border-radius:6px;animation:pulse 1.2s ease-in-out infinite"></div>
      </div>`
    ).join('');
  }

  function setSyncBadge(state) {
    const sync = document.getElementById('sync-badge');
    if (!sync) return;
    sync.classList.remove('dash-kpi-skeleton');

    if (state === 'loading') {
      sync.style.background = '#F8FAFC';
      sync.style.borderColor = '#E2E8F0';
      sync.innerHTML =
        '<div style="width:6px;height:6px;border-radius:50%;background:#94A3B8;animation:pulse 1.2s ease-in-out infinite"></div>' +
        '<span style="font-size:12px;font-weight:600;color:var(--text-3)">Synchronisation…</span>';
      return;
    }

    if (state === 'error') {
      sync.style.background = '#FEF2F2';
      sync.style.borderColor = '#FECACA';
      sync.innerHTML =
        '<div style="width:6px;height:6px;border-radius:50%;background:#DC2626"></div>' +
        '<span style="font-size:12px;font-weight:600;color:#DC2626">Erreur de sync</span>';
      return;
    }

    sync.style.background = '#ECFDF5';
    sync.style.borderColor = '#A7F3D0';
    sync.innerHTML =
      '<div style="width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 2s infinite"></div>' +
      '<span style="font-size:12px;font-weight:600;color:var(--green)">Paie synchronisée</span>';
  }

  async function applyUserFromAuth() {
    let user = window.currentUser || window.Auth?.user;
    if (!user && window.Auth?.isAuthenticated()) {
      try {
        user = await api.me();
        window.currentUser = user;
        window.Auth.user = user;
      } catch {
        return;
      }
    }
    if (!user) return;
    window.currentUser = user;

    const greeting = document.getElementById('dash-greeting');
    if (greeting) greeting.textContent = `Bonjour ${user.firstName} 👋`;

    const sub = document.getElementById('dash-subtitle');
    if (sub) {
      const d = new Date();
      sub.textContent = d.toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
    }

    const av = document.getElementById('sidebar-avatar');
    const nm = document.getElementById('sidebar-user-name');
    const rl = document.getElementById('sidebar-user-role');
    if (av) {
      av.textContent = userInitials(`${user.firstName} ${user.lastName}`);
      if (user.avatarColor) av.style.background = user.avatarColor;
    }
    if (nm) nm.textContent = `${user.firstName} ${user.lastName}`;
    if (rl) rl.textContent = user.role;
  }

  function renderDashboardKpis(k) {
    const periodLabel = formatPeriod(k.period);

    renderStrategicKpis(k);
    renderRoiFromKpis(k);

    const prepBadge = document.getElementById('kpi-prepaie-badge');
    if (prepBadge) {
      prepBadge.textContent = k.pendingVariables
        ? `${k.pendingVariables} à valider`
        : 'À jour';
      prepBadge.style.background = k.pendingVariables ? '#FFFBEB' : '#ECFDF5';
      prepBadge.style.color = k.pendingVariables ? '#D97706' : 'var(--green)';
    }

    const prepVal = document.getElementById('kpi-prepaie-value');
    if (prepVal) prepVal.textContent = k.pendingVariables;

    const prepSub = document.getElementById('kpi-prepaie-sub');
    if (prepSub) {
      prepSub.textContent = periodLabel
        ? `Variables en attente · ${periodLabel}`
        : 'Variables en attente';
    }

    const absBadge = document.getElementById('kpi-absences-badge');
    if (absBadge) {
      absBadge.textContent = k.pendingAbsences
        ? `${k.pendingAbsences} demande${k.pendingAbsences > 1 ? 's' : ''}`
        : 'Aucune';
    }

    const absVal = document.getElementById('kpi-absences-value');
    if (absVal) absVal.textContent = String(k.pendingAbsences);

    const absSub = document.getElementById('kpi-absences-sub');
    if (absSub) {
      absSub.textContent = k.activeUsers
        ? `${k.activeUsers} collaborateurs actifs`
        : 'Demandes en attente de validation';
    }

    const fluxPrepaie = document.getElementById('dash-flux-prepaie-title');
    if (fluxPrepaie) {
      if (k.pendingVariables) {
        fluxPrepaie.textContent =
          `Clôture pré-paie ${periodLabel || k.period} — ${k.pendingVariables} variable${k.pendingVariables > 1 ? 's' : ''} à valider`;
      } else {
        fluxPrepaie.textContent = periodLabel
          ? `Clôture pré-paie ${periodLabel} — à jour`
          : 'Clôture pré-paie — à jour';
      }
    }

    const absFluxTitle = document.getElementById('dash-flux-abs-title');
    if (absFluxTitle) {
      absFluxTitle.textContent = k.pendingAbsences > 0
        ? `${k.pendingAbsences} absence${k.pendingAbsences > 1 ? 's' : ''} en attente de validation`
        : 'Absences — aucune demande en attente';
    }
    const absFluxSub = document.getElementById('dash-flux-abs-sub');
    if (absFluxSub) {
      absFluxSub.textContent = periodLabel
        ? `${periodLabel} · ${k.activeUsers} collaborateur${k.activeUsers > 1 ? 's' : ''} actif${k.activeUsers > 1 ? 's' : ''}`
        : `${k.activeUsers} collaborateur${k.activeUsers > 1 ? 's' : ''} actif${k.activeUsers > 1 ? 's' : ''}`;
    }
    const absFluxStatus = document.getElementById('dash-flux1-status');
    if (absFluxStatus) {
      if (k.pendingAbsences === 0) {
        absFluxStatus.textContent = '✓ Aucune';
        absFluxStatus.style.background = 'var(--green-bg)';
        absFluxStatus.style.color = 'var(--green)';
        absFluxStatus.style.borderColor = '#A7F3D0';
      } else {
        absFluxStatus.textContent = `● En attente`;
        absFluxStatus.style.background = '#FEF2F2';
        absFluxStatus.style.color = '#DC2626';
        absFluxStatus.style.borderColor = '#FECACA';
      }
    }

    const navPrepaieBadge = document.getElementById('badge-prepaie');
    if (navPrepaieBadge) {
      const n = k.pendingVariables || 0;
      if (n > 0) { navPrepaieBadge.textContent = String(n); navPrepaieBadge.style.display = ''; }
      else navPrepaieBadge.style.display = 'none';
    }

    const navAbsBadge = document.getElementById('badge-absences');
    if (navAbsBadge) {
      const n = k.pendingAbsences || 0;
      if (n > 0) { navAbsBadge.textContent = String(n); navAbsBadge.style.display = ''; }
      else navAbsBadge.style.display = 'none';
    }

    const navFluxBadge = document.getElementById('flux-nav-badge');
    if (navFluxBadge) {
      const total = (k.pendingAbsences || 0) + (k.pendingVariables > 0 ? 1 : 0);
      if (total > 0) { navFluxBadge.textContent = String(total); navFluxBadge.style.display = ''; }
      else navFluxBadge.style.display = 'none';
    }
  }

  function renderActivityFeed(activities) {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;

    if (!activities.length) {
      feed.innerHTML =
        '<p style="padding:16px 20px;color:var(--text-3);font-size:13px">Aucune activité récente</p>';
      return;
    }

    feed.innerHTML = activities.map((a) => {
      const name = escapeHtml(a.user);
      const text = escapeHtml(a.text);
      const avatar = escapeHtml(a.avatar || '#6B7280');
      const initials = escapeHtml(userInitials(a.user));
      const time = formatRelativeTime(a.date);
      const typeBadge = a.type === 'prepaie'
        ? '<span style="background:#EFF6FF;color:var(--blue);font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;margin-left:4px">pré-paie</span>'
        : '';

      return `<div class="activity-item" style="padding:10px 20px">
        <div class="activity-avatar" style="background:${avatar};color:white;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">${initials}</div>
        <div class="activity-text"><strong>${name}</strong> ${text}${typeBadge}</div>
        <div class="activity-time">${time}</div>
      </div>`;
    }).join('');
  }

  function showActivityError(err) {
    const feed = document.getElementById('activity-feed');
    if (!feed) return;
    feed.innerHTML =
      `<p style="padding:16px 20px;color:#991B1B;font-size:13px">${escapeHtml(errorMessage(err))}</p>`;
  }

  function formatAlertDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(`${dateStr}T00:00:00`);
    const label = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
    return label.replace(/\./g, '').split(' ').map((w, i) => i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w).join(' ');
  }

  function parseAlertMsg(msg) {
    const slot = (msg.match(/^Poste (\S+)/) || [])[1] || '';
    const site = (msg.match(/sur (.+?) \(minimum/) || [])[1] || '';
    return { slot, site };
  }

  function renderPlanningAlerts(alerts) {
    const n = alerts.length;

    const planCard     = document.getElementById('plan-kpi-card');
    const planBadge    = document.getElementById('plan-alert-badge');
    const planDate     = document.getElementById('plan-kpi-date');
    const planDetailEl = document.getElementById('plan-kpi-detail');

    if (n === 0) {
      if (planCard)     planCard.style.borderColor = 'var(--border)';
      if (planBadge)    { planBadge.textContent = 'Couvert ✓'; planBadge.style.background = 'var(--green-bg)'; planBadge.style.color = 'var(--green)'; }
      if (planDate)     { planDate.textContent = '✓'; planDate.style.color = 'var(--green)'; }
      if (planDetailEl) planDetailEl.textContent = 'Planning complet cette semaine';

      const banner = document.getElementById('dash-alert-banner');
      if (banner) banner.style.display = 'none';

    } else {
      const first = alerts[0];
      const { slot, site } = parseAlertMsg(first.message);
      const dateLabel = formatAlertDate(first.date);

      if (planCard)     planCard.style.borderColor = '#FECACA';
      if (planBadge)    { planBadge.textContent = `${n} découvert${n > 1 ? 's' : ''}`; planBadge.style.background = '#FEF2F2'; planBadge.style.color = '#DC2626'; }
      if (planDate)     { planDate.textContent = dateLabel; planDate.style.color = '#DC2626'; }
      if (planDetailEl) planDetailEl.textContent = `Shift ${slot}${site ? ' · ' + site : ''}`;

      const banner = document.getElementById('dash-alert-banner');
      if (banner) {
        banner.style.display = '';
        const titleEl = document.getElementById('dash-alert-title');
        const bodyEl  = document.getElementById('dash-alert-body');
        const timeEl  = document.getElementById('dash-alert-time');
        const extra = n > 1 ? ` (+${n - 1} autre${n - 1 > 1 ? 's' : ''})` : '';
        if (titleEl) titleEl.textContent = `Poste découvert · ${dateLabel}${slot ? ', shift ' + slot : ''}${site ? ' · ' + site : ''}${extra}`;
        if (bodyEl)  bodyEl.innerHTML = escapeHtml(first.message.replace(' (minimum 2)', '')) + ' <strong>Vérifiez le planning pour couvrir ce poste.</strong>';
        if (timeEl)  timeEl.textContent = 'Cette semaine';
      }
    }

    const fluxBadge = document.getElementById('flux-count-badge');
    if (fluxBadge) {
      const pendingPrepaie = parseInt(document.getElementById('kpi-prepaie-value')?.textContent || '0', 10) || 0;
      const activeCount = (n > 0 ? 1 : 0) + (pendingPrepaie > 0 ? 1 : 0);
      fluxBadge.textContent = `${activeCount} actif${activeCount > 1 ? 's' : ''}`;
      fluxBadge.style.background = activeCount > 0 ? '#DC2626' : '#059669';
    }

    const navPlanBadge = document.getElementById('badge-planning');
    if (navPlanBadge) {
      if (n > 0) {
        navPlanBadge.textContent = String(n);
        navPlanBadge.style.display = '';
      } else {
        navPlanBadge.style.display = 'none';
      }
    }
  }

  function updateNavBadgesFromNotifications(notifs) {
    const pendingAbs = notifs.filter((n) => n.actionPage === 'absences' && n.type === 'orange').length;
    const absBadge = document.getElementById('badge-absences');
    if (absBadge) {
      if (pendingAbs > 0) { absBadge.textContent = String(pendingAbs); absBadge.style.display = ''; }
      else absBadge.style.display = 'none';
    }
  }

  async function loadDashboard() {
    if (loading) return;
    loading = true;

    const feed = document.getElementById('activity-feed');
    setKpiLoading(true);
    setSyncBadge('loading');
    if (feed) feed.innerHTML = activitySkeleton();

    let kpiOk = false;
    let activityOk = false;
    let lastError = null;

    try {
      const [kpisResult, roiResult] = await Promise.allSettled([
        api.dashboardKpis(),
        api.reportsRoi ? api.reportsRoi({ months: 6 }) : Promise.reject(new Error('API ROI indisponible')),
      ]);

      setKpiLoading(false);

      if (kpisResult.status === 'fulfilled') {
        renderDashboardKpis(kpisResult.value);
        kpiOk = true;
      } else {
        lastError = kpisResult.reason;
        if (kpisResult.reason?.status === 401) {
          window.Auth?.clear?.();
          window.location.href = LOGIN_PATH;
          return;
        }
        showKpiError(kpisResult.reason);
        showFriendlyKpiError(kpisResult.reason);
      }

      if (roiResult.status === 'fulfilled') {
        window._lastRoiReport = roiResult.value;
        if (kpisResult.status === 'fulfilled') {
          renderRoiFromReport(roiResult.value, kpisResult.value);
        } else {
          renderRoiFromReport(roiResult.value, roiResult.value);
        }
      }
    } catch (err) {
      lastError = err;
      setKpiLoading(false);
      if (err.status === 401) {
        window.Auth?.clear?.();
        window.location.href = LOGIN_PATH;
        return;
      }
      showKpiError(err);
      showFriendlyKpiError(err);
    }

    const [activityResult, alertsResult, notifsResult] = await Promise.allSettled([
      api.dashboardActivity(),
      api.planningAlerts(),
      typeof api.notifications === 'function' ? api.notifications() : Promise.reject(new Error('no notif api')),
    ]);

    if (activityResult.status === 'fulfilled') {
      renderActivityFeed(activityResult.value.activities || []);
      activityOk = true;
    } else {
      lastError = activityResult.reason;
      if (activityResult.reason?.status === 401) {
        window.Auth?.clear?.();
        window.location.href = LOGIN_PATH;
        return;
      }
      showActivityError(activityResult.reason);
    }

    if (alertsResult.status === 'fulfilled') {
      renderPlanningAlerts(alertsResult.value.alerts || []);
    } else {
      renderPlanningAlerts([]);
    }

    if (notifsResult.status === 'fulfilled') {
      updateNavBadgesFromNotifications(notifsResult.value.notifications || []);
    }

    if (kpiOk && activityOk) {
      setSyncBadge('ok');
    } else if (!kpiOk && !activityOk) {
      setSyncBadge('error');
    } else {
      setSyncBadge('error');
      if (!kpiOk) showFriendlyKpiError(lastError);
      else if (typeof showToast === 'function') {
        showToast('Certaines données du dashboard n\'ont pas pu être chargées');
      }
    }

    loading = false;
  }

  function setupAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden) loadDashboard();
    }, REFRESH_INTERVAL_MS);
  }

  function setupManualRefresh() {
    const syncBadge = document.getElementById('sync-badge');
    if (!syncBadge) return;
    syncBadge.addEventListener('click', () => {
      loadDashboard();
      if (typeof showToast === 'function') showToast('Dashboard rafraîchi');
    });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (!window.Auth?.isAuthenticated()) return;
    await applyUserFromAuth();
    // applyAuthenticatedSession est déjà appelé par le bootstrap maquette — ne pas le refaire
    if (window.Auth?.user?.role === 'COLLABORATEUR') return;
    loadDashboard();
    setupAutoRefresh();
    setupManualRefresh();
  });

  window.loadDashboard = loadDashboard;
  window.renderActivityFeed = renderActivityFeed;
  window.renderDashboardKpis = renderDashboardKpis;
})();
