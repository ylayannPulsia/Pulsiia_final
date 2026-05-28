// flux-api.js — Flux & Actions : chargement dynamique des données réelles
(function () {
  'use strict';

  /* ─── Helpers ─────────────────────────────────────────────── */
  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function fmtDate(str) {
    if (!str) return '';
    const d = new Date(str + 'T00:00:00');
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function fmtRelative(isoStr) {
    if (!isoStr) return '';
    const diff = Date.now() - new Date(isoStr).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'à l\'instant';
    if (m < 60) return `il y a ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `il y a ${h}h`;
    const days = Math.floor(h / 24);
    return `il y a ${days} jour${days > 1 ? 's' : ''}`;
  }

  function parsePlanningMsg(msg) {
    const slot = (msg.match(/^Poste (\S+)/) || [])[1] || 'matin';
    const site = (msg.match(/sur (.+?) \(minimum/) || [])[1] || '';
    return { slot, site };
  }

  /* ─── Build flux items HTML ───────────────────────────────── */

  function buildAbsenceItem(absence) {
    const user = absence.user || {};
    const name = user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Collaborateur';
    const site = user.siteName || user.site || '';
    const start = fmtDate(absence.startDate);
    const end   = fmtDate(absence.endDate);
    const range = (start && end && start !== end) ? `${start} – ${end}` : (start || end || '');
    const when  = fmtRelative(absence.createdAt);
    const days  = absence.days || absence.workingDays || '';
    const type  = absence.typeLabel || absence.type || 'Absence';

    const isManager = window._fluxIsManager;
    const actionBtns = isManager
      ? `<div style="display:flex;gap:8px;margin-top:4px">
           <button class="btn btn-ghost" style="color:var(--green);border-color:var(--green)" onclick="fluxApproveAbsence('${esc(absence.id)}',this)">✓ Approuver</button>
           <button class="btn btn-ghost" style="color:#DC2626;border-color:#DC2626" onclick="fluxRefuseAbsence('${esc(absence.id)}',this)">✕ Refuser</button>
         </div>`
      : `<p style="font-size:12px;color:var(--text-3);margin:0">En attente de validation par le manager.</p>`;

    return `<div class="flux-item flux-actif" data-abs-id="${esc(absence.id)}"
        style="background:white;border:1.5px solid #FECACA;border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)">
      <div style="padding:16px 20px;border-bottom:1px solid #FECACA;background:#FEF2F2;display:flex;align-items:center;gap:12px;cursor:pointer"
           onclick="toggleFlux(this)">
        <div style="width:10px;height:10px;border-radius:50%;background:#DC2626;flex-shrink:0;animation:pulse 1.5s infinite"></div>
        <div style="flex:1">
          <div style="font-size:13.5px;font-weight:700;color:#991B1B">Absence ${esc(name)} — ${esc(type)}</div>
          <div style="font-size:12px;color:#B91C1C;margin-top:1px">${esc(range)}${days ? ' · ' + days + ' jour' + (days > 1 ? 's' : '') : ''}${site ? ' · ' + esc(site) : ''}${when ? ' · ' + when : ''}</div>
        </div>
        <span style="font-size:11px;font-weight:700;background:#DC2626;color:white;padding:3px 10px;border-radius:20px;flex-shrink:0">● En attente</span>
        <svg class="flux-chevron" width="14" height="14" viewBox="0 0 16 16" fill="#DC2626" style="transition:transform .2s;flex-shrink:0">
          <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
        </svg>
      </div>
      <div class="flux-detail" style="padding:20px 24px">
        <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:8px;padding:12px 14px;font-size:13px;color:#991B1B;line-height:1.6;margin-bottom:14px">
          <strong>${esc(name)}</strong> · ${esc(type)}<br>
          ${range ? `Du ${range}` : ''}${days ? ` · ${days} jour${days > 1 ? 's' : ''}` : ''}
          ${absence.reason ? `<br><em style="color:#9CA3AF;font-size:12px">Motif : ${esc(absence.reason)}</em>` : ''}
        </div>
        ${actionBtns}
      </div>
    </div>`;
  }

  function buildPlanningItem(alerts) {
    if (!alerts.length) return '';
    const n = alerts.length;
    const byDate = {};
    alerts.forEach(a => { (byDate[a.date] = byDate[a.date] || []).push(a); });
    const dates = Object.keys(byDate).sort();
    const shownDates = dates.slice(0, 4);

    const rows = shownDates.map(date => {
      const d = new Date(date + 'T00:00:00');
      const fmt = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
      const cnt = byDate[date].length;
      const { slot, site } = parsePlanningMsg(byDate[date][0].message);
      return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#FEF2F2;border:1px solid #FECACA;border-radius:7px;font-size:13px;color:#991B1B">
        <div style="width:7px;height:7px;border-radius:50%;background:#DC2626;flex-shrink:0;animation:pulse 1.5s infinite"></div>
        <span style="flex:1"><strong>${esc(fmt)}</strong> · Shift ${esc(slot)}${site ? ' · ' + esc(site) : ''}</span>
        <span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:4px;border:1px solid #FECACA;color:#DC2626;background:white">${cnt} poste${cnt > 1 ? 's' : ''}</span>
      </div>`;
    }).join('');
    const moreDates = dates.length > shownDates.length
      ? `<p style="font-size:12px;color:var(--text-3);padding:2px 0;margin:0">+${dates.length - shownDates.length} autre${dates.length - shownDates.length > 1 ? 's' : ''} dates concernées…</p>`
      : '';
    const dCount = dates.length;

    return `<div class="flux-item flux-actif"
        style="background:white;border:1.5px solid #FECACA;border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)">
      <div style="padding:16px 20px;border-bottom:1px solid #FECACA;background:#FEF2F2;display:flex;align-items:center;gap:12px;cursor:pointer"
           onclick="toggleFlux(this)">
        <div style="width:10px;height:10px;border-radius:50%;background:#DC2626;flex-shrink:0;animation:pulse 1.5s infinite"></div>
        <div style="flex:1">
          <div style="font-size:13.5px;font-weight:700;color:#991B1B">${n} poste${n > 1 ? 's' : ''} découvert${n > 1 ? 's' : ''} cette semaine</div>
          <div style="font-size:12px;color:#B91C1C;margin-top:1px">Couverture insuffisante · ${dCount} jour${dCount > 1 ? 's' : ''} concerné${dCount > 1 ? 's' : ''}</div>
        </div>
        <span style="font-size:11px;font-weight:700;background:#DC2626;color:white;padding:3px 10px;border-radius:20px;flex-shrink:0">● Actif</span>
        <svg class="flux-chevron" width="14" height="14" viewBox="0 0 16 16" fill="#DC2626" style="transform:rotate(-90deg);transition:transform .2s;flex-shrink:0">
          <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
        </svg>
      </div>
      <div class="flux-detail" style="display:none;padding:20px 24px">
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${rows}${moreDates}</div>
        <button class="btn btn-ghost" onclick="showPage('planning',document.querySelector('.nav-item[onclick*=planning]'))">Voir le planning →</button>
      </div>
    </div>`;
  }

  function buildPrepaieItem(pendingVars, period) {
    if (!pendingVars.length) return '';
    const count = pendingVars.length;
    const anomalies = pendingVars.filter(v => v.statusCode === 'ANOMALIE');
    const periodFmt = period
      ? new Date(period + '-01').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
      : '';

    const rows = pendingVars.slice(0, 6).map(v => {
      const isAnom = v.statusCode === 'ANOMALIE';
      const bg     = isAnom ? '#FFFBEB' : 'var(--bg)';
      const border = isAnom ? 'border:1px solid #FDE68A;' : '';
      const badge  = isAnom
        ? `<span class="status-badge error"><span class="status-dot"></span>Anomalie IA</span>`
        : `<span class="status-badge warn"><span class="status-dot"></span>À valider</span>`;
      return `<div style="display:flex;align-items:center;gap:8px;padding:10px 14px;background:${bg};${border}border-radius:7px;font-size:13px">
        <span style="flex:1;min-width:0"><strong>${esc(v.collab)}</strong> · ${esc(v.type)}</span>
        <span style="font-family:monospace;font-weight:600;flex-shrink:0">${esc(v.value)}</span>
        ${badge}
      </div>`;
    }).join('');
    const moreVars = pendingVars.length > 6
      ? `<p style="font-size:12px;color:var(--text-3);margin:4px 0 0">+${pendingVars.length - 6} autre${pendingVars.length - 6 > 1 ? 's' : ''} variables…</p>`
      : '';
    const anomalyNote = anomalies.length
      ? `<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:7px;padding:10px 12px;font-size:12.5px;color:#92400E;margin-bottom:10px">
           ⚠ ${anomalies.length} anomalie${anomalies.length > 1 ? 's' : ''} IA détectée${anomalies.length > 1 ? 's' : ''} — vérifiez avant validation.
         </div>`
      : '';

    return `<div class="flux-item flux-attente"
        style="background:white;border:1.5px solid #FDE68A;border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)">
      <div style="padding:16px 20px;border-bottom:1px solid #FDE68A;background:#FFFBEB;display:flex;align-items:center;gap:12px;cursor:pointer"
           onclick="toggleFlux(this)">
        <div style="width:10px;height:10px;border-radius:50%;background:#D97706;flex-shrink:0"></div>
        <div style="flex:1">
          <div style="font-size:13.5px;font-weight:700;color:#92400E">
            Clôture pré-paie${periodFmt ? ' ' + periodFmt : ''} — ${count} variable${count > 1 ? 's' : ''} à valider
          </div>
          <div style="font-size:12px;color:#B45309;margin-top:1px">
            Échéance vendredi${anomalies.length ? ' · ' + anomalies.length + ' anomalie' + (anomalies.length > 1 ? 's' : '') + ' IA' : ''}
          </div>
        </div>
        <span style="font-size:11px;font-weight:700;background:#D97706;color:white;padding:3px 10px;border-radius:20px;flex-shrink:0">⚠ À valider</span>
        <svg class="flux-chevron" width="14" height="14" viewBox="0 0 16 16" fill="#D97706" style="transform:rotate(-90deg);transition:transform .2s;flex-shrink:0">
          <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
        </svg>
      </div>
      <div class="flux-detail" style="display:none;padding:20px 24px">
        ${anomalyNote}
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${rows}${moreVars}</div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" onclick="showPage('prepaie',document.querySelector('.nav-item[onclick*=prepaie]'))">Voir pré-paie →</button>
          <button class="btn btn-primary" onclick="fluxValidateAll('${esc(String(period || ''))}',${count})">Valider les ${count} variable${count > 1 ? 's' : ''}</button>
        </div>
      </div>
    </div>`;
  }

  function buildWellbeingMeetingItem(m) {
    const when = m.scheduledAt
      ? new Date(m.scheduledAt).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      : '';
    return `<div class="flux-item flux-attente" data-meeting-id="${esc(m.id)}"
        style="background:white;border:1.5px solid #BFCFFE;border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)">
      <div style="padding:16px 20px;border-bottom:1px solid #BFCFFE;background:#EFF6FF;display:flex;align-items:center;gap:12px;cursor:pointer"
           onclick="toggleFlux(this)">
        <div style="width:10px;height:10px;border-radius:50%;background:#2563EB;flex-shrink:0"></div>
        <div style="flex:1">
          <div style="font-size:13.5px;font-weight:700;color:#1D4ED8">Point bien-être — ${esc(m.teamLabel)}</div>
          <div style="font-size:12px;color:#3B82F6;margin-top:1px">${esc(m.type || 'Entretien')} · ${esc(when)}</div>
        </div>
        <span style="font-size:11px;font-weight:700;background:#2563EB;color:white;padding:3px 10px;border-radius:20px">📅 Planifié</span>
      </div>
      <div class="flux-detail" style="display:none;padding:20px 24px">
        ${m.note ? `<p style="font-size:13px;color:var(--text-2);margin:0 0 12px">${esc(m.note)}</p>` : ''}
        <p style="font-size:12px;color:var(--text-3);margin:0 0 12px">Créé par ${esc(m.createdBy || 'RH')}</p>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" onclick="showPage('bienetre',document.querySelector('.nav-item[onclick*=bienetre]'))">Voir bien-être →</button>
          <button class="btn btn-primary" onclick="fluxCompleteMeeting('${esc(m.id)}',this)">Marquer comme fait</button>
        </div>
      </div>
    </div>`;
  }

  window.fluxCompleteMeeting = async function (id, btn) {
    try {
      await api.wellbeingUpdateMeeting(id, { status: 'DONE' });
      const item = btn?.closest('.flux-item');
      if (item) item.remove();
      if (typeof showToast === 'function') showToast('✅ Entretien marqué comme réalisé');
      _refreshKpis();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
    }
  };

  /* ─── Main loader ─────────────────────────────────────────── */

  async function loadFluxPage() {
    const list     = document.getElementById('flux-list');
    const loadMore = document.getElementById('flux-load-more');
    if (!list) return;

    // Detect role for action buttons (Auth.user stored in localStorage under 'user')
    try {
      const me = (typeof Auth !== 'undefined' && Auth.user) || JSON.parse(localStorage.getItem('user') || '{}');
      window._fluxIsManager = ['MANAGER', 'RH', 'DRH', 'ADMIN'].includes(me && me.role);
    } catch (_e) { window._fluxIsManager = false; }

    // Loading skeleton
    list.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-3);font-size:13.5px">Chargement des flux…</div>';
    if (loadMore) loadMore.style.display = 'none';

    try {
      // Parallel API calls — allSettled so one 403 doesn't block the rest
      const [absRes, ppRes, alertsRes, summaryRes, meetRes] = await Promise.allSettled([
        api.absences({ status: 'EN_ATTENTE' }),
        api.prepaieVariables(),
        api.planningAlerts(),
        api.prepaieSummary(),
        api.wellbeingMeetings ? api.wellbeingMeetings('PLANNED') : Promise.resolve({ meetings: [] }),
      ]);

      const absences   = absRes.status === 'fulfilled'    ? (absRes.value.absences  || []) : [];
      const allPpVars  = ppRes.status  === 'fulfilled'    ? (ppRes.value.variables  || []) : [];
      const ppPeriod   = ppRes.status  === 'fulfilled'    ? ppRes.value.period             : null;
      const planAlerts = alertsRes.status === 'fulfilled' ? (alertsRes.value.alerts || []) : [];
      const summary    = summaryRes.status === 'fulfilled'? summaryRes.value               : null;
      const meetings   = meetRes.status === 'fulfilled'   ? (meetRes.value.meetings || []) : [];

      // Keep only pending variables (A_VALIDER + ANOMALIE)
      const pendingPP = allPpVars.filter(function(v) {
        return v && (v.statusCode === 'A_VALIDER' || v.statusCode === 'ANOMALIE');
      });

      /* ─ Build items ─ */
      var parts = [];
      try { if (planAlerts.length) parts.push(buildPlanningItem(planAlerts)); } catch(e) { console.error('flux planning item', e); }
      meetings.forEach(function (m) { try { parts.push(buildWellbeingMeetingItem(m)); } catch (e) { console.error('flux meeting', e); } });
      absences.forEach(function(a) { try { parts.push(buildAbsenceItem(a)); } catch(e) { console.error('flux absence item', e); } });
      try { if (pendingPP.length)  parts.push(buildPrepaieItem(pendingPP, ppPeriod)); } catch(e) { console.error('flux prepaie item', e); }

      if (parts.length === 0) {
        list.innerHTML = '<div style="padding:48px 24px;text-align:center"><div style="font-size:36px;margin-bottom:12px">✓</div><div style="font-size:15px;font-weight:700;color:var(--text)">Aucun flux en cours</div><div style="font-size:13px;color:var(--text-3);margin-top:4px">Tout est à jour — aucune action requise.</div></div>';
      } else {
        list.innerHTML = parts.join('');
      }

      /* ─ Update KPIs ─ */
      var nActive   = absences.length + meetings.length + (planAlerts.length > 0 ? 1 : 0);
      var nPending  = pendingPP.length;
      var nResolved = summary ? (summary.validated || 0) : 0;

      var kpiActif   = document.getElementById('flux-kpi-actif');
      var kpiAttente = document.getElementById('flux-kpi-attente');
      var kpiResolu  = document.getElementById('flux-kpi-resolu');
      if (kpiActif)   kpiActif.textContent   = String(nActive);
      if (kpiAttente) kpiAttente.textContent = String(nPending);
      if (kpiResolu)  kpiResolu.textContent  = String(nResolved);

      /* ─ Update nav badge ─ */
      var navBadge = document.getElementById('flux-nav-badge');
      if (navBadge) {
        var total = nActive + (pendingPP.length > 0 ? 1 : 0) + meetings.length;
        navBadge.textContent = String(total);
        navBadge.style.display = total > 0 ? '' : 'none';
      }

    } catch (err) {
      console.error('loadFluxPage error:', err);
      list.innerHTML = '<div style="padding:32px;text-align:center;color:#DC2626;font-size:13.5px">Erreur lors du chargement des flux. Veuillez réessayer.</div>';
    }
  }

  /* ─── Actions ─────────────────────────────────────────────── */

  window.fluxApproveAbsence = async function (id, btn) {
    const item = btn ? btn.closest('.flux-item') : document.querySelector(`[data-abs-id="${id}"]`);
    try {
      await api.updateAbsenceStatus(id, 'APPROUVE', null);
      if (item) {
        item.style.borderColor = '#A7F3D0';
        item.className = item.className.replace('flux-actif', 'flux-resolu');
        const header = item.querySelector('[onclick="toggleFlux(this)"]');
        if (header) { header.style.background = '#ECFDF5'; header.style.borderColor = '#A7F3D0'; }
        const dot = item.querySelector('[style*="animation:pulse"]');
        if (dot) { dot.style.background = 'var(--green)'; dot.style.animation = ''; }
        const badge = item.querySelector('[style*="border-radius:20px"]');
        if (badge) { badge.textContent = '✓ Approuvé'; badge.style.background = 'var(--green)'; }
        const detail = item.querySelector('.flux-detail');
        if (detail) detail.innerHTML = '<p style="color:var(--green);font-size:13px;font-weight:600;margin:0">✓ Absence approuvée avec succès.</p>';
      }
      if (typeof showToast === 'function') showToast('Absence approuvée ✓');
      if (typeof loadDashboard === 'function') loadDashboard();
      _refreshKpis();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur lors de l\'approbation');
    }
  };

  window.fluxRefuseAbsence = async function (id, btn) {
    const reason = window.prompt('Motif de refus (obligatoire) :');
    if (!reason || !reason.trim()) return;
    const item = btn ? btn.closest('.flux-item') : document.querySelector(`[data-abs-id="${id}"]`);
    try {
      await api.updateAbsenceStatus(id, 'REFUSE', reason.trim());
      if (item) {
        item.style.borderColor = 'var(--border)';
        item.className = item.className.replace('flux-actif', 'flux-resolu');
        const badge = item.querySelector('[style*="border-radius:20px"]');
        if (badge) { badge.textContent = '✕ Refusé'; badge.style.background = '#6B7280'; }
        const detail = item.querySelector('.flux-detail');
        if (detail) detail.innerHTML = `<p style="color:var(--text-2);font-size:13px;margin:0">✕ Absence refusée. Motif : <em>${esc(reason)}</em></p>`;
      }
      if (typeof showToast === 'function') showToast('Absence refusée');
      if (typeof loadDashboard === 'function') loadDashboard();
      _refreshKpis();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur lors du refus');
    }
  };

  window.fluxValidateAll = async function (period, count) {
    try {
      const res = await api.validateAllVariables(period || undefined);
      if (typeof showToast === 'function') showToast(res.message || `${count} variable${count > 1 ? 's' : ''} validée${count > 1 ? 's' : ''} ✓`);
      await loadFluxPage();
      if (typeof loadDashboard === 'function') loadDashboard();
    } catch (err) {
      if (typeof showToast === 'function') showToast(
        err.error || (err.status === 403 ? 'Action réservée au DRH / admin pour la validation en masse.' : 'Erreur lors de la validation')
      );
    }
  };

  /* Recalculate KPI counts after an inline action without full reload */
  function _refreshKpis() {
    const actifs  = document.querySelectorAll('#flux-list .flux-actif').length;
    const attente = document.querySelectorAll('#flux-list .flux-attente').length;
    const kpiActif   = document.getElementById('flux-kpi-actif');
    const kpiAttente = document.getElementById('flux-kpi-attente');
    if (kpiActif)   kpiActif.textContent   = String(actifs);
    if (kpiAttente) kpiAttente.textContent = String(attente);
    const navBadge = document.getElementById('flux-nav-badge');
    if (navBadge) {
      const total = actifs + attente;
      navBadge.textContent = String(total);
      navBadge.style.display = total > 0 ? '' : 'none';
    }
  }

  window.loadFluxPage = loadFluxPage;
})();
