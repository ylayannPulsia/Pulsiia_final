// bienetre-api.js — Page bien-être branchée API (DRH, manager, collab)
(function () {
  'use strict';

  const ENT_KEY = 'pulsiia_be_entretiens';
  window.beSiteFilter = '';

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/"/g, '&quot;');
  }

  function fmtScore(s) {
    if (s == null) return '—';
    const n = Number(s);
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  function scoreCssColor(s) {
    if (s == null) return 'var(--text-2)';
    if (s >= 7) return 'var(--green)';
    if (s >= 5) return 'var(--orange)';
    return 'var(--red)';
  }

  function trendLabel(delta) {
    if (delta == null) return '→ Stable';
    if (delta > 0) return '↑ +' + delta;
    if (delta < 0) return '↓ ' + delta;
    return '→ Stable';
  }

  function formatWeekLabel(weekLabel, weekStart) {
    if (weekStart) {
      const d = new Date(weekStart);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
      }
    }
    if (!weekLabel) return '—';
    const m = String(weekLabel).match(/(\d{1,2})[\/\-.](\d{1,2})/);
    if (m) return m[1] + '/' + m[2];
    return String(weekLabel).replace(/^semaine du\s*/i, '').trim().slice(0, 12);
  }

  const MIN_ANON = 5;

  function beResolveRole() {
    const apiRole = window.Auth?.user?.role || window.currentUser?.role;
    if (apiRole === 'MANAGER') return 'manager';
    if (apiRole === 'COLLABORATEUR') return 'collab';
    if (['DRH', 'RH', 'ADMIN'].includes(apiRole)) return 'drh';
    return window.currentRole || 'drh';
  }

  function isManagerBienetreScoped() {
    return beResolveRole() === 'manager';
  }

  function applyManagerBienetreUI() {
    if (!isManagerBienetreScoped()) return;
    const drh = document.getElementById('bienetre-drh');
    const mgr = document.getElementById('bienetre-manager');
    const collab = document.getElementById('bienetre-collab');
    if (drh) drh.style.display = 'none';
    if (mgr) mgr.style.display = 'block';
    if (collab) collab.style.display = 'none';
    window.beSiteFilter = '';
  }

  function mapTeamsFromScores(data) {
    if (!data?.bySite) return;
    window.wellbeingTeams = data.bySite
      .filter((s) => s.siteId != null && s.meetsAnonymity && s.averageScore != null)
      .map((s) => ({
        siteId: s.siteId,
        name: s.siteName,
        count: s.eligibleCount || 0,
        score: s.averageScore ?? 0,
        trend: 0,
        alert: (s.averageScore ?? 0) < 6,
        absenceRate: null,
        meetsAnonymity: true,
        responseCount: s.responseCount || 0,
      }));
  }

  function applyCorrelationToTeams() {
    const corr = window.beCorrelation;
    if (!corr?.sites || !window.wellbeingTeams) return;
    corr.sites.forEach((c) => {
      const t = window.wellbeingTeams.find((x) => x.siteId === c.siteId);
      if (t) {
        t.absenceRate = c.absenceRate;
        if (c.score != null) t.score = c.score;
      }
    });
  }

  function buildDynamicConseils() {
    const teams = window.wellbeingTeams || [];
    const allSites = (window.__beAllSites || []).filter((s) => s.siteId && s.meetsAnonymity);
    const questions = window.wellbeingQScores || [];
    const items = [];
    const alerts = allSites.filter((s) => s.averageScore != null && s.averageScore < 6);
    alerts.forEach((s) => {
      const t = teams.find((x) => x.siteId === s.siteId) || { name: s.siteName, siteId: s.siteId, score: s.averageScore, absenceRate: null };
      items.push({
        level: 'error',
        tag: 'Alerte',
        title: t.name + ' — score ' + fmtScore(t.score) + '/10',
        text: 'Équipe sous le seuil critique. Absentéisme estimé ' + (t.absenceRate != null ? t.absenceRate + '%' : '—') + '.',
        action: 'Planifier un point manager',
        actionFn: 'planifierEntretien',
        teamName: t.name,
        siteId: t.siteId,
        color: '#DC2626',
        bg: '#FEF2F2',
        border: '#FECACA',
      });
    });
    const weakQ = [...questions].filter((q) => q.score != null).sort((a, b) => a.score - b.score)[0];
    if (weakQ && weakQ.score < 7) {
      items.push({
        level: 'warn',
        tag: 'Vigilance',
        title: 'Indicateur faible — « ' + weakQ.q + ' »',
        text: 'Score moyen ' + fmtScore(weakQ.score) + '/10 sur l\'ensemble des équipes.',
        action: 'Vérifier le planning S+2',
        actionFn: 'planning',
        color: '#D97706',
        bg: '#FFFBEB',
        border: '#FDE68A',
      });
    }
    const best = [...teams].filter((t) => t.score != null).sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 7.5) {
      items.push({
        level: 'ok',
        tag: 'Positif',
        title: best.name + ' — ' + fmtScore(best.score) + '/10',
        text: 'Meilleure performance du groupe cette semaine.',
        action: null,
        color: '#059669',
        bg: '#ECFDF5',
        border: '#A7F3D0',
      });
    }
    const part = window.__beExport?.participationRate;
    const surveyId = window.__beExport?.survey?.id;
    if (part != null && part < 80 && surveyId) {
      items.push({
        level: part < 50 ? 'warn' : 'ok',
        tag: 'Participation',
        title: 'Participation QCM — ' + part + '%',
        text: part >= 60 ? 'Taux correct — une relance peut améliorer la représentativité.' : 'Taux faible — relancez les collaborateurs.',
        action: 'Relancer le QCM',
        actionFn: 'remind-qcm',
        surveyId,
        color: '#2563EB',
        bg: '#EFF6FF',
        border: '#BFCFFE',
      });
    }
    return items.length ? items : null;
  }

  function renderConseilsList(conseils) {
    const el = document.getElementById('be-ia-conseils');
    if (!el) return;
    const list = conseils || buildDynamicConseils();
    if (!list?.length) {
      el.innerHTML = '<div style="padding:20px;color:var(--text-3);font-size:13px">Aucun point d\'attention cette semaine.</div>';
      return;
    }
    el.innerHTML = list.map((c, i) => {
      const isLast = i === list.length - 1;
      let actionBtn = '';
      if (c.action && c.actionFn === 'planifierEntretien') {
        actionBtn = `<button type="button" class="btn btn-ghost" style="font-size:12px;padding:5px 12px" data-be-action="planifier-entretien" data-team="${esc(c.teamName || '')}" data-site-id="${esc(c.siteId || '')}">${esc(c.action)} →</button>`;
      } else if (c.action && c.actionFn === 'planning') {
        actionBtn = `<button type="button" class="btn btn-ghost" style="font-size:12px;padding:5px 12px" data-be-action="planning">${esc(c.action)} →</button>`;
      } else if (c.actionFn === 'remind-qcm' && c.surveyId) {
        actionBtn = `<button type="button" class="btn btn-ghost" style="font-size:12px;padding:5px 12px" onclick="beRemindQcm('${esc(c.surveyId)}')">${esc(c.action)} →</button>`;
      } else if (c.action) {
        actionBtn = `<button type="button" class="btn btn-ghost" style="font-size:12px;padding:5px 12px">${esc(c.action)} →</button>`;
      }
      return `<div style="display:flex;align-items:flex-start;gap:14px;padding:14px 20px;${isLast ? '' : 'border-bottom:1px solid var(--border)'}">
        <div style="width:8px;height:8px;border-radius:50%;background:${c.color};flex-shrink:0;margin-top:4px"></div>
        <div style="flex:1"><div style="margin-bottom:4px"><span style="font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:4px;background:${c.bg};color:${c.color};border:1px solid ${c.border}">${esc(c.tag)}</span>
        <span style="font-size:13px;font-weight:600;margin-left:8px">${esc(c.title)}</span></div>
        <div style="font-size:12.5px;color:var(--text-2);line-height:1.55">${esc(c.text)}</div></div>${actionBtn}</div>`;
    }).join('');
  }

  function fillSiteFilter(sites) {
    const sel = document.getElementById('be-filter-site');
    if (!sel) return;
    const cur = window.beSiteFilter;
    sel.innerHTML = '<option value="">Tous les sites</option>' + (sites || [])
      .filter((s) => s.siteId)
      .map((s) => `<option value="${esc(s.siteId)}"${cur === s.siteId ? ' selected' : ''}>${esc(s.siteName)}</option>`)
      .join('');
  }

  let beApiLoaded = false;

  async function loadDrhData() {
    window.beScoresError = null;
    const siteId = window.beSiteFilter || undefined;
    try {
      const [scoresRes, trendsRes, corrRes] = await Promise.allSettled([
        api.wellbeingScores(siteId),
        api.wellbeingTrends(4, siteId),
        api.wellbeingCorrelation(),
      ]);

      if (scoresRes.status === 'rejected') {
        throw scoresRes.reason;
      }
      const scores = scoresRes.value;
      const trends = trendsRes.status === 'fulfilled' ? trendsRes.value : { points: [] };
      const correlation = corrRes.status === 'fulfilled' ? corrRes.value : { sites: [] };

      window.__beExport = scores;
      window.beCorrelation = correlation;
      mapTeamsFromScores(scores);
      applyCorrelationToTeams();

      if (scores.byQuestion?.length) {
        window.wellbeingQScores = scores.byQuestion.map((q) => ({
          q: q.text,
          type: q.type,
          score: q.averageScore ?? 0,
          textResponseCount: q.textResponseCount,
          trend: q.trend ?? 0,
          distribution: q.distribution,
          signal: q.signal,
        }));
      }

      if (trends.points?.length) {
        window.beTrendData = trends.points.map((p) => ({
          week: formatWeekLabel(p.weekLabel, p.weekStart),
          score: p.averageScore,
        }));
        window.beTrendFromApiOnly = trends.points.length >= 4;
      } else {
        window.beTrendData = null;
        window.beTrendFromApiOnly = false;
      }

      if (!siteId) window.__beAllSites = scores.bySite || [];
      fillSiteFilter(window.__beAllSites || scores.bySite);
      beApiLoaded = true;
      return scores;
    } catch (err) {
      if (err?.status === 0) {
        window.beScoresError = 'Connexion impossible — vérifiez que le backend tourne (port 3001).';
      } else {
        window.beScoresError = err.error || err.message || 'Scores indisponibles.';
        if (err.status === 403) window.beScoresError = 'Scores réservés aux managers et RH.';
      }
      throw err;
    }
  }

  function updateDrhKpis(scores) {
    const teams = window.wellbeingTeams || [];
    const globalScore = scores.globalScore != null
      ? scores.globalScore
      : teams.length
        ? +(teams.reduce((a, t) => a + (t.score || 0) * (t.count || 1), 0)
            / Math.max(1, teams.reduce((a, t) => a + (t.count || 1), 0))).toFixed(1)
        : null;

    const gEl = document.getElementById('be-global-score');
    if (gEl && globalScore != null) {
      gEl.textContent = globalScore;
      gEl.style.color = scoreCssColor(globalScore);
    }
    const deltaEl = document.getElementById('be-global-delta');
    if (deltaEl) {
      const prev = scores.previousGlobalScore;
      const d = prev != null && globalScore != null ? +(globalScore - prev).toFixed(1) : null;
      deltaEl.textContent = '/10' + (d != null ? ' · ' + trendLabel(d) + ' vs sem. préc.' : '');
      deltaEl.style.color = d > 0 ? 'var(--green)' : d < 0 ? 'var(--red)' : 'var(--text-2)';
    }
    const pEl = document.getElementById('be-participation');
    if (pEl && scores.participationRate != null) pEl.textContent = scores.participationRate + '%';
    const pSub = pEl?.parentElement?.querySelector('div:last-child');
    if (pSub && scores.responseCount != null) {
      pSub.textContent = scores.responseCount + ' réponse' + (scores.responseCount > 1 ? 's' : '') + ' anonyme' + (scores.responseCount > 1 ? 's' : '');
    }
    const allSites = (window.__beAllSites || scores.bySite || []).filter((s) => s.siteId);
    const alerts = allSites.filter((s) => s.meetsAnonymity && (s.averageScore ?? 10) < 6).length;
    const aEl = document.getElementById('be-alerts-count');
    if (aEl) {
      aEl.textContent = alerts;
      aEl.style.color = alerts > 0 ? 'var(--orange)' : 'var(--green)';
    }
    const best = [...teams].filter((t) => t.score != null).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const bEl = document.getElementById('be-best-team');
    const bsEl = document.getElementById('be-best-team-score');
    if (best && bEl) bEl.textContent = best.name;
    if (best && bsEl) bsEl.textContent = fmtScore(best.score) + ' / 10';
    const sc = document.getElementById('be-sites-count');
    if (sc) sc.textContent = String((scores.bySite || []).filter((s) => s.siteId).length);

    const sub = document.getElementById('be-page-subtitle');
    if (sub) {
      const wl = scores.survey?.weekLabel || 'Semaine en cours';
      sub.textContent = (window.beSiteFilter ? 'Filtre actif · ' : 'Toutes les équipes · ')
        + wl + ' · Données anonymisées';
    }
    const ad = document.getElementById('be-attention-date');
    if (ad) ad.textContent = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const attTitle = document.getElementById('be-attention-title');
    if (attTitle) {
      attTitle.textContent = 'Points d\'attention — ' + (scores.survey?.weekLabel || 'Semaine en cours');
    }
    injectDrhHeaderActions(scores);
    const qSub = document.getElementById('be-qcm-subtitle');
    if (qSub && scores.byQuestion?.length) {
      qSub.textContent = scores.byQuestion.length + ' question(s) · ' + (scores.responseCount || 0) + ' réponses anonymisées';
    }
  }

  function renderApiTrendChart() {
    const chart = document.getElementById('be-trend-chart');
    if (!chart) return;
    const rows = (window.beTrendData && window.beTrendData.length)
      ? window.beTrendData.filter(function (p) { return p.score != null; })
      : [];
    if (!rows.length) {
      chart.innerHTML = '<div style="padding:16px;color:var(--text-3);font-size:12px">Aucun historique disponible.</div>';
      return;
    }
    const barMaxPx = 96;
    chart.innerHTML = rows.map(function (d, i) {
      const score = Number(d.score);
      const h = Math.max(10, Math.round((score / 10) * barMaxPx));
      const active = i === rows.length - 1;
      const label = Number.isInteger(score) ? score : score.toFixed(1);
      return '<div class="be-trend-col">'
        + '<div class="be-trend-score ' + (active ? 'active' : 'inactive') + '">' + label + '</div>'
        + '<div class="be-trend-bar-wrap"><div class="be-trend-bar ' + (active ? 'active' : 'inactive') + '" style="height:' + h + 'px" title="' + label + '/10"></div></div>'
        + '<div class="be-trend-week">' + esc(d.week || '') + '</div></div>';
    }).join('');
  }

  function renderDrhBody() {
    if (window.beScoresError) {
      const grid = document.getElementById('be-teams-grid');
      if (grid) {
        grid.innerHTML = '<div style="padding:24px;color:#991B1B;font-size:13px">' + esc(window.beScoresError)
          + ' <button type="button" class="btn btn-ghost" onclick="renderWellbeing()">Réessayer</button></div>';
      }
      return;
    }
    if (beApiLoaded) {
      renderBeTeamsGrid();
      renderBeQcmTable();
      renderApiTrendChart();
      if (typeof window.renderWellbeingScatter === 'function') window.renderWellbeingScatter();
      renderConseilsList(buildDynamicConseils());
      bindConseilsActions();
      return;
    }
    if (typeof window.renderWellbeingDrhBody === 'function') {
      window.renderWellbeingDrhBody();
      renderConseilsList(buildDynamicConseils());
      return;
    }
    renderConseilsList(buildDynamicConseils());
  }

  window.beOnFilterSite = function (val) {
    window.beSiteFilter = val || '';
    const gEl = document.getElementById('be-global-score');
    if (gEl) gEl.textContent = '…';
    loadDrhData()
      .then((scores) => {
        updateDrhKpis(scores);
        renderDrhBody();
      })
      .catch(() => renderDrhBody());
  };

  async function renderManager() {
    document.getElementById('bienetre-drh').style.display = 'none';
    document.getElementById('bienetre-collab').style.display = 'none';
    document.getElementById('bienetre-manager').style.display = 'block';

    const sub = document.getElementById('be-mgr-subtitle');
    if (sub) sub.textContent = 'Chargement…';

    try {
      const data = await api.wellbeingMyTeam();
      if (!data.available) {
        if (sub) sub.textContent = (data.siteName || 'Mon équipe') + ' · ' + (data.responseCount || 0) + '/' + (data.minRequired || MIN_ANON) + ' réponses';
        document.getElementById('be-mgr-score-num').textContent = '—';
        document.getElementById('be-mgr-conseil-text').innerHTML = esc(
          data.message || ('En attente de ' + MIN_ANON + ' réponses anonymes pour afficher le score agrégé.')
        );
        document.getElementById('be-mgr-questions').innerHTML = '';
        const mgrActs0 = document.getElementById('be-mgr-actions');
        if (mgrActs0) mgrActs0.innerHTML = '';
        return;
      }
      if (sub) {
        sub.textContent = (data.site?.name || 'Mon équipe') + ' · '
          + (data.eligibleCount || '—') + ' personnes dans votre équipe · Données anonymisées';
      }
      let mgrActs = document.getElementById('be-mgr-actions');
      if (!mgrActs) {
        const hdr = document.querySelector('#bienetre-manager [style*="justify-content:space-between"]');
        if (hdr) {
          mgrActs = document.createElement('div');
          mgrActs.id = 'be-mgr-actions';
          mgrActs.style.cssText = 'display:flex;gap:8px';
          hdr.appendChild(mgrActs);
        }
      }
      if (mgrActs) {
        window._beMgrPlanCtx = { team: data.site.name, siteId: data.site.id };
        mgrActs.innerHTML = `
          <button type="button" class="btn btn-ghost" onclick="planifierEntretien(window._beMgrPlanCtx)">Planifier entretien</button>
          <button type="button" class="btn btn-ghost" onclick="downloadRapportEquipe()">↓ Export équipe</button>`;
      }
      const sn = document.getElementById('be-mgr-score-num');
      if (sn) {
        sn.textContent = fmtScore(data.score);
        sn.style.color = scoreCssColor(data.score);
      }
      document.getElementById('be-mgr-score-title').textContent = 'Score bien-être — ' + (data.site?.name || 'Mon équipe');
      document.getElementById('be-mgr-score-meta').textContent = trendLabel(data.trendDelta) + ' vs semaine précédente';
      document.getElementById('be-mgr-participation').textContent = (data.participationRate ?? '—') + '%';
      document.getElementById('be-mgr-members').textContent = data.eligibleCount ?? '—';

      const conseil = data.byQuestion?.length
        ? buildMgrConseil(data.score, data.byQuestion)
        : { icon: '💡', text: 'Score agrégé de votre équipe.', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFCFFE' };
      const box = document.getElementById('be-mgr-conseil');
      if (box) {
        box.style.background = conseil.bg;
        box.style.borderColor = conseil.border;
      }
      document.getElementById('be-mgr-conseil-icon').textContent = conseil.icon;
      document.getElementById('be-mgr-conseil-text').innerHTML = '<strong>Conseil :</strong> ' + esc(conseil.text);
      document.getElementById('be-mgr-conseil-text').style.color = conseil.color;

      const qEl = document.getElementById('be-mgr-questions');
      if (qEl && data.byQuestion?.length) {
        qEl.innerHTML = data.byQuestion.map((q) => {
          const s = q.averageScore ?? 0;
          const col = scoreCssColor(s);
          return `<div><div style="display:flex;justify-content:space-between;margin-bottom:6px">
            <span style="font-size:13px;font-weight:500">${esc(q.text)}</span>
            <span style="font-size:13px;font-weight:700;color:${col}">${fmtScore(s)} / 10</span></div>
            <div style="height:8px;background:var(--bg);border-radius:4px;overflow:hidden">
            <div style="width:${s * 10}%;height:100%;background:${col};border-radius:4px"></div></div></div>`;
        }).join('');
      }
    } catch (e) {
      if (sub) sub.textContent = e.error || e.message || 'Erreur de chargement';
    }
  }

  function buildMgrConseil(score, questions) {
    const weak = [...questions].filter((q) => q.averageScore != null).sort((a, b) => a.averageScore - b.averageScore)[0];
    if (score < 6) {
      return { icon: '🚨', color: '#991B1B', bg: '#FEF2F2', border: '#FECACA', text: 'Score critique. Point faible : « ' + (weak?.text || '—') + ' ».' };
    }
    if (score < 7.5) {
      return { icon: '💡', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFCFFE', text: 'Score correct. Surveiller « ' + (weak?.text || 'charge') + ' » (' + fmtScore(weak?.averageScore) + '/10).' };
    }
    return { icon: '✅', color: '#065F46', bg: '#ECFDF5', border: '#A7F3D0', text: 'Bonne dynamique d\'équipe. Maintenir l\'équilibre au planning.' };
  }

  async function renderCollab() {
    document.getElementById('bienetre-drh').style.display = 'none';
    document.getElementById('bienetre-manager').style.display = 'none';
    document.getElementById('bienetre-collab').style.display = 'block';

    try {
      const data = await api.wellbeingMyTeam();
      const label = document.getElementById('be-collab-site-label');
      const scoreEl = document.getElementById('be-collab-score');
      const meta = document.getElementById('be-collab-meta');
      const alert = document.getElementById('be-collab-alert');
      const footer = document.getElementById('be-collab-footer');

      if (!data.available) {
        if (label) label.textContent = 'Score équipe — non disponible';
        if (scoreEl) scoreEl.textContent = '—';
        if (meta) meta.textContent = data.message || 'Minimum 5 réponses requises';
        if (alert) alert.style.display = 'none';
        if (footer) footer.textContent = 'Participez au QCM pour contribuer au score de votre équipe 💪';
        return;
      }

      if (label) label.textContent = 'Score bien-être — ' + data.site.name;
      if (scoreEl) {
        scoreEl.textContent = fmtScore(data.score);
        scoreEl.style.color = scoreCssColor(data.score);
      }
      if (meta) meta.textContent = '/10 · ' + trendLabel(data.trendDelta) + ' vs semaine dernière';

      if (alert) {
        if (data.score < 6 || (data.trendDelta != null && data.trendDelta < -0.5)) {
          alert.style.display = 'inline-block';
          alert.style.padding = '10px 16px';
          alert.style.background = 'var(--orange-bg)';
          alert.style.borderRadius = '8px';
          alert.style.fontSize = '12.5px';
          alert.style.color = 'var(--orange)';
          alert.textContent = '⚠️ Score en vigilance — votre manager est informé';
        } else {
          alert.style.display = 'none';
        }
      }

      const histWrap = document.getElementById('be-collab-history-wrap');
      const histEl = document.getElementById('be-collab-history');
      if (data.personalHistory?.length && histWrap && histEl) {
        histWrap.style.display = 'block';
        histEl.innerHTML = data.personalHistory.map((h) => {
          const c = scoreCssColor(h.score);
          return `<div style="padding:10px 14px;background:var(--bg);border-radius:8px;min-width:72px;text-align:center">
            <div style="font-size:16px;font-weight:700;color:${c}">${fmtScore(h.score)}</div>
            <div style="font-size:10px;color:var(--text-3);margin-top:4px">${esc(formatWeekLabel(h.weekLabel, h.weekStart))}</div></div>`;
        }).join('');
      }

      if (footer) {
        footer.innerHTML = data.qcmPending
          ? '⚠️ <strong>QCM du jour non complété</strong> — <a href="#" onclick="showPage(\'qcm\',document.querySelector(\'.nav-item[onclick*=qcm]\'));return false" style="color:var(--blue)">Répondre maintenant</a>'
          : '✓ QCM de la semaine complété — merci pour votre participation 💪';
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message || 'Chargement impossible'));
    }
  }

  async function beRenderWellbeing() {
    const role = beResolveRole();
    window.currentRole = role;
    applyManagerBienetreUI();

    if (role !== 'drh' && role !== 'manager') {
      await renderCollab();
      return;
    }
    if (role === 'manager') {
      await renderManager();
      return;
    }

    document.getElementById('bienetre-drh').style.display = 'block';
    document.getElementById('bienetre-manager').style.display = 'none';
    document.getElementById('bienetre-collab').style.display = 'none';

    const gEl = document.getElementById('be-global-score');
    if (gEl) gEl.textContent = '…';

    try {
      const scores = await loadDrhData();
      updateDrhKpis(scores);
      renderDrhBody();
    } catch (_e) {
      renderDrhBody();
    }
  }

  /** Panneau détail — données API */
  async function beOpenTeamDetail(idx) {
    let team = window.wellbeingTeams?.[idx];
    if (!team?.siteId) {
      const sites = (window.__beAllSites || []).filter((s) => s.siteId);
      const s = sites[idx];
      if (s) {
        team = { siteId: s.siteId, name: s.siteName, score: s.averageScore };
      }
    }
    if (!team?.siteId) {
      if (typeof window.openTeamDetail === 'function' && window.openTeamDetail !== beOpenTeamDetail) {
        return window.openTeamDetail(idx);
      }
      return;
    }
    window.currentTeamDetailName = team.name;
    window.currentTeamDetailSiteId = team.siteId;

    try {
      const d = await api.wellbeingSiteDetail(team.siteId);
      window.__beLastSiteDetail = d;
      bePopulateTeamPanel(d, team);
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message || 'Détail indisponible'));
      if (typeof window.openTeamDetail === 'function') {
        const orig = window._beOrigOpenTeamDetail;
        if (orig) orig(idx);
      }
    }
  }

  function bePopulateTeamPanel(d, team) {
    const panel = document.getElementById('team-detail-panel');
    const backdrop = document.getElementById('team-detail-backdrop');
    if (!panel || !backdrop) return;

    const score = d.score ?? team.score;
    const sc = scoreCssColor(score);
    const icon = score < 6 ? '⚠️' : score >= 8 ? '✅' : '➡️';
    const iconBg = score < 6 ? '#FEF2F2' : score >= 8 ? '#ECFDF5' : '#EFF6FF';
    const iconBorder = score < 6 ? '#FECACA' : score >= 8 ? '#A7F3D0' : '#BFCFFE';

    document.getElementById('tdp-icon').textContent = icon;
    document.getElementById('tdp-icon').style.background = iconBg;
    document.getElementById('tdp-icon').style.border = '1.5px solid ' + iconBorder;
    document.getElementById('tdp-name').textContent = d.site?.name || team.name;
    document.getElementById('tdp-meta').textContent = (d.eligibleCount || 0) + ' pers. · '
      + (d.responseCount || 0) + ' réponses · Absentéisme ~' + (d.absenceRate ?? '—') + '%';

    document.getElementById('tdp-score-row').innerHTML = `
      <div style="background:var(--bg);border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:10px;color:var(--text-3);text-transform:uppercase;margin-bottom:6px">Score</div>
        <div style="font-size:28px;font-weight:800;color:${sc}">${fmtScore(score)}</div></div>
      <div style="background:var(--bg);border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:10px;color:var(--text-3);text-transform:uppercase;margin-bottom:6px">Tendance</div>
        <div style="font-size:22px;font-weight:800;color:${(d.trendDelta || 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${trendLabel(d.trendDelta)}</div></div>
      <div style="background:var(--bg);border-radius:8px;padding:14px;text-align:center">
        <div style="font-size:10px;color:var(--text-3);text-transform:uppercase;margin-bottom:6px">Participation</div>
        <div style="font-size:22px;font-weight:800;color:var(--blue)">${d.participationRate ?? '—'}%</div></div>`;

    const hist = d.history || [];
    const maxH = hist.length || 1;
    document.getElementById('tdp-history-chart').innerHTML = hist.map((h, i) => {
      const s = h.score ?? 0;
      const hPx = Math.round((s / 10) * 80);
      const barC = scoreCssColor(s);
      const isLast = i === hist.length - 1;
      return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
        <div style="font-size:10px;font-weight:600;color:${isLast ? barC : 'var(--text-3)'}">${fmtScore(s)}</div>
        <div style="width:100%;height:${hPx}px;border-radius:4px 4px 0 0;background:${isLast ? barC : barC + '55'};border:1.5px solid ${barC}"></div></div>`;
    }).join('');
    document.getElementById('tdp-history-labels').innerHTML = hist.map((h) =>
      `<div style="flex:1;text-align:center;font-size:10px;color:var(--text-3)">${esc(formatWeekLabel(h.weekLabel, h.weekStart))}</div>`
    ).join('');

    document.getElementById('tdp-corr-bars').innerHTML = hist.slice(-4).map((h) => {
      const s = h.score ?? 0;
      const c = scoreCssColor(s);
      const pct = Math.round((s / 10) * 100);
      return `<div style="margin-bottom:8px"><div style="font-size:11px;margin-bottom:4px">${esc(formatWeekLabel(h.weekLabel, h.weekStart))} · ${h.responseCount || 0} rép.</div>
        <div style="height:7px;background:#E5E7EB;border-radius:4px"><div style="width:${pct}%;height:100%;background:${c};border-radius:4px"></div></div></div>`;
    }).join('') || '<div style="font-size:12px;color:var(--text-3)">Historique insuffisant</div>';

    document.getElementById('tdp-qcm-breakdown').innerHTML = (d.byQuestion || []).map((q) => {
      const s = q.averageScore ?? 0;
      const c = scoreCssColor(s);
      return `<div style="display:flex;align-items:center;gap:10px"><div style="flex:1;font-size:12.5px">${esc(q.text)}</div>
        <div style="width:90px;height:5px;background:var(--bg);border-radius:3px"><div style="width:${s * 10}%;height:100%;background:${c}"></div></div>
        <div style="font-size:12px;font-weight:700;color:${c}">${fmtScore(s)}</div></div>`;
    }).join('');

    const ci = d.conseil || {};
    const el = document.getElementById('tdp-ia-conseil');
    el.style.background = ci.bg || '#EFF6FF';
    el.style.border = '1px solid ' + (ci.border || '#BFCFFE');
    el.innerHTML = `<div style="font-size:11px;font-weight:700;color:${ci.color || '#1D4ED8'};margin-bottom:6px">${ci.icon || '💡'} Analyse</div>
      <div style="font-size:13px;color:${ci.color || '#1D4ED8'};line-height:1.55">${esc(ci.text || '')}</div>`;

    backdrop.style.display = 'block';
    panel.style.display = 'block';
    requestAnimationFrame(() => requestAnimationFrame(() => { panel.style.transform = 'translateX(0)'; }));
  }

  function downloadCsv() {
    const data = window.__beExport;
    if (!data) {
      if (typeof showToast === 'function') showToast('⚠️ Aucune donnée à exporter');
      return;
    }
    const rows = [['Type', 'Libellé', 'Score', 'Participation', 'Réponses']];
    rows.push(['Global', 'Entreprise', data.globalScore ?? '', data.participationRate ?? '', data.responseCount ?? '']);
    (data.bySite || []).forEach((s) => {
      rows.push(['Site', s.siteName, s.averageScore ?? '', s.participationRate ?? '', s.responseCount ?? '']);
    });
    (data.byQuestion || []).forEach((q) => {
      rows.push(['Question', q.text, q.averageScore ?? '', '', q.responseCount ?? '']);
    });
    const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(';')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bienetre-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    if (typeof showToast === 'function') showToast('✅ Export CSV téléchargé');
  }

  function injectDrhHeaderActions(scores) {
    const hdr = document.querySelector('#bienetre-drh [style*="justify-content:space-between"]');
    if (!hdr) return;
    let wrap = document.getElementById('be-extra-actions');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'be-extra-actions';
      wrap.style.cssText = 'display:flex;gap:8px;align-items:center';
      const btnCfg = hdr.querySelector('[onclick*="openQCMConfig"]');
      if (btnCfg?.parentNode) btnCfg.parentNode.insertBefore(wrap, btnCfg);
      else hdr.appendChild(wrap);
    }
    const surveyId = scores.survey?.id;
    const lowPart = (scores.participationRate ?? 100) < 60;
    wrap.innerHTML = (surveyId && lowPart
      ? `<button type="button" class="btn btn-ghost" onclick="beRemindQcm('${esc(surveyId)}')">🔔 Relancer QCM</button>`
      : '')
      + `<button type="button" class="btn btn-ghost" onclick="beDownloadPdfReport()">↓ Rapport PDF</button>`;
  }

  window.beRemindQcm = async function (surveyId) {
    try {
      const res = await api.wellbeingRemindSurvey(surveyId);
      if (typeof showToast === 'function') showToast('✅ ' + (res.message || 'Relance envoyée'));
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message));
    }
  };

  function renderBeTeamsGrid() {
    const grid = document.getElementById('be-teams-grid');
    if (!grid) return;
    const sites = (window.__beAllSites || []).filter((s) => s.siteId);
    if (!sites.length) {
      grid.innerHTML = '<div style="padding:24px;color:var(--text-2);font-size:13px">Aucun établissement actif.</div>';
      return;
    }
    grid.innerHTML = sites.map((s, idx) => {
      if (s.meetsAnonymity && s.averageScore != null) {
        const tIdx = (window.wellbeingTeams || []).findIndex((t) => t.siteId === s.siteId);
        const openIdx = tIdx >= 0 ? tIdx : idx;
        const score = s.averageScore;
        const c = score >= 7.5 ? 'var(--green)' : score >= 5 ? 'var(--orange)' : 'var(--red)';
        const bg = score < 6 ? '#FEF2F2' : 'white';
        const bdr = score < 6 ? '#FECACA' : 'var(--border)';
        const icon = score < 6 ? '⚠️' : score >= 8 ? '✅' : '➡️';
        return `<div onclick="openTeamDetail(${openIdx})" style="background:${bg};border:1.5px solid ${bdr};border-radius:var(--radius);padding:18px;box-shadow:var(--shadow);cursor:pointer">
          <div style="display:flex;justify-content:space-between;margin-bottom:10px"><span style="font-size:13px;font-weight:600">${esc(s.siteName)}</span><span>${icon}</span></div>
          <div style="font-size:26px;font-weight:800;color:${c}">${fmtScore(score)}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:6px">${s.responseCount}/${s.eligibleCount} rép. · anonymisé</div>
          <div style="margin-top:8px;font-size:11px;color:var(--blue)">Voir le détail →</div></div>`;
      }
      const need = Math.max(0, MIN_ANON - (s.responseCount || 0));
      return `<div style="background:#FFFBEB;border:1.5px dashed #FDE68A;border-radius:var(--radius);padding:18px;opacity:.95">
        <div style="font-size:13px;font-weight:600;color:#92400E;margin-bottom:8px">${esc(s.siteName)}</div>
        <div style="font-size:12px;color:#B45309;line-height:1.5">En attente d'anonymat RGPD<br><strong>${s.responseCount || 0} / ${MIN_ANON}</strong> réponses (encore ${need})</div>
        <button type="button" class="btn btn-ghost" style="font-size:11px;margin-top:10px;padding:4px 10px" onclick="event.stopPropagation();beRemindQcm('${esc(window.__beExport?.survey?.id || '')}')">Relancer le QCM</button></div>`;
    }).join('');
  }

  function renderBeQcmTable() {
    const tbody = document.getElementById('be-qcm-table-body');
    if (!tbody) return;
    const rows = window.wellbeingQScores || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;color:var(--text-2)">Aucune donnée QCM.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map((q) => {
      const sig = q.signal || { level: 'ok', text: 'Normal' };
      const sigBadge = `<span class="status-badge ${sig.level}"><span class="status-dot"></span>${esc(sig.text)}</span>`;
      if (q.type === 'TEXT') {
        const count = q.textResponseCount ?? 0;
        return `<tr>
        <td style="padding:12px 16px;font-size:13px;border-bottom:1px solid var(--border)">${esc(q.q)} <span style="font-size:10px;color:var(--text-3)">(texte libre)</span></td>
        <td style="padding:12px 16px;font-size:13px;color:var(--text-2);border-bottom:1px solid var(--border)">—</td>
        <td style="padding:12px 16px;font-size:13px;color:var(--text-2);border-bottom:1px solid var(--border)">—</td>
        <td style="padding:12px 16px;font-size:13px;border-bottom:1px solid var(--border)">${count} remarque${count > 1 ? 's' : ''}</td>
        <td style="padding:12px 16px;border-bottom:1px solid var(--border)">${sigBadge}</td></tr>`;
      }
      const trend = q.trend ?? 0;
      const trendCol = trend > 0 ? 'var(--green)' : trend < 0 ? 'var(--red)' : 'var(--text-2)';
      const trendStr = trend > 0 ? '↑ +' + trend : trend < 0 ? '↓ ' + trend : '→ Stable';
      const score = q.score ?? 0;
      const d = q.distribution || { lowPct: 0, midPct: 0, highPct: 100 };
      const col = score >= 7.5 ? 'var(--green)' : score >= 5 ? 'var(--orange)' : 'var(--red)';
      return `<tr>
        <td style="padding:12px 16px;font-size:13px;border-bottom:1px solid var(--border)">${esc(q.q)}</td>
        <td style="padding:12px 16px;font-size:13px;font-weight:700;border-bottom:1px solid var(--border);color:${col}">${fmtScore(score)}/10</td>
        <td style="padding:12px 16px;font-size:13px;color:${trendCol};border-bottom:1px solid var(--border)">${trendStr}</td>
        <td style="padding:12px 16px;border-bottom:1px solid var(--border)">
          <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;width:140px">
            <div style="background:#059669;width:${d.highPct || 0}%"></div>
            <div style="background:#D97706;width:${d.midPct || 0}%"></div>
            <div style="background:#DC2626;width:${d.lowPct || 0}%"></div>
          </div></td>
        <td style="padding:12px 16px;border-bottom:1px solid var(--border)">${sigBadge}</td></tr>`;
    }).join('');
  }

  function patchScatterInsight() {
    if (typeof window.renderWellbeingScatter !== 'function') return;
    const orig = window.renderWellbeingScatter;
    window.renderWellbeingScatter = function () {
      const svg = document.getElementById('be-scatter-svg');
      const card = svg ? svg.closest('.be-scatter-card') : null;
      const usingApi = window.beCorrelation?.sites?.length && (window.wellbeingTeams || []).length;
      if (!usingApi) {
        if (card) card.style.display = 'none';
        return;
      }
      if (card) card.style.display = '';
      orig();
      const insight = document.getElementById('be-scatter-insight');
      if (insight && !usingApi) {
        insight.textContent = '';
      }
    };
  }

  window.beDownloadPdfReport = function () {
    const data = window.__beExport;
    if (!data) {
      if (typeof showToast === 'function') showToast('⚠️ Chargez d\'abord les données');
      return;
    }
    const title = 'Rapport Bien-être — ' + (data.survey?.weekLabel || new Date().toLocaleDateString('fr-FR'));
    const sitesHtml = (data.bySite || []).filter((s) => s.siteId).map((s) =>
      `<tr><td>${esc(s.siteName)}</td><td>${s.meetsAnonymity ? fmtScore(s.averageScore) + '/10' : 'En attente (' + (s.responseCount || 0) + '/5)'}</td><td>${s.participationRate ?? '—'}%</td></tr>`
    ).join('');
    const qHtml = (data.byQuestion || []).map((q) =>
      q.type === 'TEXT'
        ? `<tr><td>${esc(q.text)} (texte libre)</td><td>—</td><td>${q.textResponseCount ?? 0} remarque(s)</td></tr>`
        : `<tr><td>${esc(q.text)}</td><td>${fmtScore(q.averageScore)}/10</td><td>${q.trend != null ? trendLabel(q.trend) : '—'}</td></tr>`
    ).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>body{font-family:system-ui,sans-serif;padding:32px;color:#111}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f4f4f5}</style></head>
      <body><h1>${esc(title)}</h1><p>Score global : <strong>${fmtScore(data.globalScore)}/10</strong> · Participation : ${data.participationRate ?? '—'}%</p>
      <h2>Établissements</h2><table><thead><tr><th>Site</th><th>Score</th><th>Participation</th></tr></thead><tbody>${sitesHtml}</tbody></table>
      <h2>Questions QCM</h2><table><thead><tr><th>Question</th><th>Score</th><th>Tendance</th></tr></thead><tbody>${qHtml}</tbody></table>
      <p style="font-size:11px;color:#666">Données anonymisées — Pulsiia</p></body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rapport-bienetre-' + new Date().toISOString().slice(0, 10) + '.html';
    a.click();
    URL.revokeObjectURL(a.href);
    if (typeof showToast === 'function') showToast('✅ Rapport téléchargé (ouvrez le fichier puis Imprimer → PDF)');
  };

  window.downloadRapportEquipe = function () {
    const d = window.__beLastSiteDetail;
    const name = window.currentTeamDetailName || d?.site?.name || 'equipe';
    if (!d) {
      if (typeof showToast === 'function') showToast('⚠️ Ouvrez d\'abord le détail d\'une équipe');
      return;
    }
    const rows = [['Indicateur', 'Valeur'], ['Équipe', name], ['Score', d.score ?? ''], ['Participation', (d.participationRate ?? '') + '%'], ['Absentéisme', (d.absenceRate ?? '') + '%']];
    (d.byQuestion || []).forEach((q) => rows.push([q.text, q.averageScore ?? '']));
    const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(';')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rapport-equipe-' + name.replace(/\s+/g, '-').toLowerCase() + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    if (typeof showToast === 'function') showToast('✅ Rapport équipe CSV téléchargé');
  };

  const BE_DEFAULT_QCM_QUESTIONS = [
    'Comment vous sentez-vous ce matin ?',
    'Votre charge de travail est-elle supportable ?',
    'Vous sentez-vous soutenu(e) par votre équipe ?',
    'Disposez-vous des ressources nécessaires ?',
  ];
  const BE_DEFAULT_TEXT_QUESTION = 'Avez-vous des remarques à faire ?';

  function beDefaultSurveyQuestions() {
    return [
      ...BE_DEFAULT_QCM_QUESTIONS.map((text, i) => ({ text, order: i + 1, type: 'SCALE' })),
      { text: BE_DEFAULT_TEXT_QUESTION, order: 5, type: 'TEXT', optional: true },
    ];
  }

  window.beToggleQuestionType = function (sel) {
    const row = sel.closest('.be-q-row');
    const wrap = row?.querySelector('.be-q-optional-wrap');
    if (wrap) wrap.style.display = sel.value === 'TEXT' ? 'flex' : 'none';
  };

  function beMonday(d) {
    const x = new Date(d);
    const day = x.getDay();
    x.setDate(x.getDate() - day + (day === 0 ? -6 : 1));
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function fmtSurveyDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function openQcmConfigModal() {
    let modal = document.getElementById('modal-be-qcm-config');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modal-be-qcm-config';
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal-box" style="max-width:640px;max-height:90vh;display:flex;flex-direction:column">
          <div class="modal-header">
            <div class="modal-title">Configurer le QCM bien-être</div>
            <div class="modal-header-close" onclick="beCloseQcmConfig()">✕</div>
          </div>
          <div class="modal-body" id="be-qcm-config-body" style="gap:14px;overflow-y:auto;flex:1"></div>
          <div class="modal-footer" id="be-qcm-config-footer">
            <button type="button" class="btn btn-ghost" onclick="beCloseQcmConfig()">Fermer</button>
            <button type="button" class="btn btn-primary" onclick="beCreateSurveyDraft()">+ Nouveau sondage</button>
          </div>
        </div>`;
      modal.addEventListener('click', (e) => { if (e.target === modal) beCloseQcmConfig(); });
      document.body.appendChild(modal);
    }
    window._beQcmEditingId = null;
    modal.classList.add('open');
    beLoadQcmConfigList();
  }

  window.beCloseQcmConfig = function () {
    const modal = document.getElementById('modal-be-qcm-config');
    if (modal) modal.classList.remove('open');
    window._beQcmEditingId = null;
    const footer = document.getElementById('be-qcm-config-footer');
    if (footer) {
      footer.innerHTML = `
        <button type="button" class="btn btn-ghost" onclick="beCloseQcmConfig()">Fermer</button>
        <button type="button" class="btn btn-primary" onclick="beCreateSurveyDraft()">+ Nouveau sondage</button>`;
    }
    beLoadQcmConfigList();
  };

  async function beLoadQcmConfigList() {
    if (window._beQcmEditingId) return;
    const body = document.getElementById('be-qcm-config-body');
    if (!body) return;
    body.innerHTML = '<p style="color:var(--text-2)">Chargement…</p>';
    try {
      const { surveys } = await api.wellbeingSurveysList();
      if (!surveys?.length) {
        body.innerHTML = '<p style="color:var(--text-2)">Aucun sondage. Créez-en un pour démarrer.</p>';
        return;
      }
      body.innerHTML = surveys.map((s) => {
        const st = s.status === 'ACTIVE' ? 'var(--green)' : s.status === 'DRAFT' ? 'var(--orange)' : 'var(--text-3)';
        const period = fmtSurveyDate(s.weekStart) + ' → ' + fmtSurveyDate(s.endsAt);
        const work = s.onlyOnWorkShifts !== false ? ' · jours planifiés' : ' · tous les jours';
        const act = s.status !== 'ACTIVE' && s.status !== 'CLOSED'
          ? `<button type="button" class="btn btn-primary" style="font-size:12px" onclick="beActivateSurvey('${esc(s.id)}')">Activer</button>`
          : '';
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px">${esc(s.weekLabel)}</div>
            <div style="font-size:11px;color:${st}">${esc(s.status)} · ${s.durationDays || 7} j · ${period}${work}</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:2px">${s.responseCount || 0} réponses · ${(s.questions || []).length} questions</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button type="button" class="btn btn-ghost" style="font-size:12px" onclick="beEditSurvey('${esc(s.id)}')">Modifier</button>${act}
          </div></div>`;
      }).join('');
    } catch (e) {
      body.innerHTML = '<p style="color:#991B1B">' + esc(e.error || e.message) + '</p>';
    }
  }

  function beRenderQuestionRows(questions, locked) {
    const rows = (questions && questions.length ? questions : beDefaultSurveyQuestions());
    return rows.map((q, i) => {
      const isText = q.type === 'TEXT';
      const optional = isText && q.optional !== false;
      return `
      <div class="be-q-row" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center">
        <span style="font-size:12px;color:var(--text-3);width:18px">${i + 1}.</span>
        <select class="form-input be-q-type" style="width:132px;flex-shrink:0" ${locked ? 'disabled' : ''} onchange="beToggleQuestionType(this)">
          <option value="SCALE" ${!isText ? 'selected' : ''}>Échelle 1–10</option>
          <option value="TEXT" ${isText ? 'selected' : ''}>Texte libre</option>
        </select>
        <input type="text" class="form-input be-q-text" value="${esc(q.text || '')}" ${locked ? 'disabled' : ''} style="flex:1;min-width:160px">
        <label class="be-q-optional-wrap" style="display:${isText ? 'flex' : 'none'};align-items:center;gap:4px;font-size:11px;color:var(--text-2);white-space:nowrap">
          <input type="checkbox" class="be-q-optional" ${optional ? 'checked' : ''} ${locked ? 'disabled' : ''}>
          Facultatif
        </label>
        ${locked ? '' : `<button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onclick="beRemoveQuestionRow(this)" ${rows.length <= 1 ? 'disabled' : ''}>✕</button>`}
      </div>`;
    }).join('');
  }

  window.beRemoveQuestionRow = function (btn) {
    const row = btn.closest('.be-q-row');
    const list = document.getElementById('be-q-questions-list');
    if (row && list && list.querySelectorAll('.be-q-row').length > 1) row.remove();
  };

  window.beAddQuestionRow = function () {
    const list = document.getElementById('be-q-questions-list');
    if (!list || list.querySelectorAll('.be-q-row').length >= 5) {
      if (typeof showToast === 'function') showToast('⚠️ Maximum 5 questions');
      return;
    }
    const div = document.createElement('div');
    div.className = 'be-q-row';
    div.style.cssText = 'display:flex;gap:8px;margin-bottom:8px;align-items:center';
    const n = list.querySelectorAll('.be-q-row').length + 1;
    div.innerHTML = `<span style="font-size:12px;color:var(--text-3);width:18px">${n}.</span>
      <select class="form-input be-q-type" style="width:132px;flex-shrink:0" onchange="beToggleQuestionType(this)">
        <option value="SCALE" selected>Échelle 1–10</option>
        <option value="TEXT">Texte libre</option>
      </select>
      <input type="text" class="form-input be-q-text" placeholder="Nouvelle question…" style="flex:1;min-width:160px">
      <label class="be-q-optional-wrap" style="display:none;align-items:center;gap:4px;font-size:11px;color:var(--text-2);white-space:nowrap">
        <input type="checkbox" class="be-q-optional" checked> Facultatif
      </label>
      <button type="button" class="btn btn-ghost" style="padding:4px 8px;font-size:11px" onclick="beRemoveQuestionRow(this)">✕</button>`;
    list.appendChild(div);
  };

  function beCollectQuestionsFromForm() {
    return [...document.querySelectorAll('#be-q-questions-list .be-q-row')]
      .map((row, i) => {
        const text = row.querySelector('.be-q-text')?.value?.trim();
        if (!text) return null;
        const type = row.querySelector('.be-q-type')?.value === 'TEXT' ? 'TEXT' : 'SCALE';
        const optional = type === 'TEXT' && row.querySelector('.be-q-optional')?.checked;
        return { text, order: i + 1, type, optional: type === 'TEXT' ? optional : false };
      })
      .filter(Boolean);
  }

  window.beEditSurvey = async function (id) {
    const body = document.getElementById('be-qcm-config-body');
    const footer = document.getElementById('be-qcm-config-footer');
    if (!body) return;
    body.innerHTML = '<p style="color:var(--text-2)">Chargement…</p>';
    window._beQcmEditingId = id;
    try {
      const { survey } = await api.wellbeingGetSurvey(id);
      const locked = (survey.responseCount || 0) > 0;
      const startVal = survey.weekStart ? new Date(survey.weekStart).toISOString().slice(0, 10) : '';
      body.innerHTML = `
        <p style="font-size:12px;color:var(--text-2);margin:0 0 12px">Paramètres du questionnaire · statut <strong>${esc(survey.status)}</strong>
          ${locked ? ' · <span style="color:#991B1B">questions verrouillées (réponses enregistrées)</span>' : ''}</p>
        <div class="form-group">
          <label class="form-label">Libellé</label>
          <input type="text" class="form-input" id="be-survey-label" value="${esc(survey.weekLabel)}">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group">
            <label class="form-label">Date de début</label>
            <input type="date" class="form-input" id="be-survey-start" value="${startVal}" ${survey.status === 'CLOSED' ? 'disabled' : ''}>
          </div>
          <div class="form-group">
            <label class="form-label">Durée (jours ouvrés)</label>
            <input type="number" class="form-input" id="be-survey-duration" min="1" max="14" value="${survey.durationDays || 7}">
          </div>
        </div>
        <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;cursor:pointer;margin-bottom:12px">
          <input type="checkbox" id="be-survey-workdays" ${survey.onlyOnWorkShifts !== false ? 'checked' : ''} style="margin-top:3px">
          <span><strong>QCM actif uniquement les jours travaillés</strong><br>
          <span style="font-size:12px;color:var(--text-2)">Le collaborateur ne voit le QCM que s'il a un créneau planifié ce jour-là (hors repos / OFF).</span></span>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;font-size:13px;cursor:pointer;margin-bottom:16px">
          <input type="checkbox" id="be-survey-custom" ${survey.isCustom ? 'checked' : ''} style="margin-top:3px">
          <span><strong>Sondage RH personnalisé</strong><br>
          <span style="font-size:12px;color:var(--text-2)">Mêmes questions toute la période. Décoché = rotation automatique de questions chaque jour.</span></span>
        </label>
        <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px">Questions (1 à 5)</div>
        <div id="be-q-questions-list">${beRenderQuestionRows(survey.questions, locked)}</div>
        ${locked ? '' : '<button type="button" class="btn btn-ghost" style="font-size:12px;margin-top:4px" onclick="beAddQuestionRow()">+ Ajouter une question</button>'}`;

      if (footer) {
        footer.innerHTML = `
          <button type="button" class="btn btn-ghost" onclick="beCloseQcmConfig()">Annuler</button>
          <button type="button" class="btn btn-ghost" onclick="beLoadQcmConfigList();window._beQcmEditingId=null">← Liste</button>
          <button type="button" class="btn btn-primary" onclick="beSaveSurvey('${esc(id)}')">Enregistrer</button>
          ${survey.status !== 'ACTIVE' && survey.status !== 'CLOSED'
            ? `<button type="button" class="btn btn-primary" onclick="beSaveAndActivateSurvey('${esc(id)}')">Enregistrer et activer</button>` : ''}
          ${survey.status === 'ACTIVE'
            ? `<button type="button" class="btn btn-ghost" onclick="beCloseSurvey('${esc(id)}')">Clôturer</button>` : ''}`;
      }
    } catch (e) {
      body.innerHTML = '<p style="color:#991B1B">' + esc(e.error || e.message) + '</p>';
      window._beQcmEditingId = null;
    }
  };

  window.beSaveSurvey = async function (id, opts) {
    opts = opts || {};
    const questions = beCollectQuestionsFromForm();
    if (!questions.length) {
      if (typeof showToast === 'function') showToast('⚠️ Ajoutez au moins une question');
      return false;
    }
    const payload = {
      weekLabel: document.getElementById('be-survey-label')?.value?.trim(),
      weekStart: document.getElementById('be-survey-start')?.value
        ? new Date(document.getElementById('be-survey-start').value).toISOString()
        : undefined,
      durationDays: parseInt(document.getElementById('be-survey-duration')?.value, 10) || 7,
      onlyOnWorkShifts: document.getElementById('be-survey-workdays')?.checked !== false,
      isCustom: document.getElementById('be-survey-custom')?.checked === true,
      questions,
    };
    try {
      await api.wellbeingUpdateSurvey(id, payload);
      if (!opts.silent && typeof showToast === 'function') showToast('✅ Sondage enregistré');
      if (!opts.keepOpen) {
        window._beQcmEditingId = null;
        beCloseQcmConfig();
      }
      renderWellbeing();
      return true;
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message));
      return false;
    }
  };

  window.beSaveAndActivateSurvey = async function (id) {
    const ok = await window.beSaveSurvey(id, { keepOpen: true, silent: true });
    if (!ok) return;
    try {
      await api.wellbeingActivateSurvey(id);
      if (typeof showToast === 'function') showToast('✅ Sondage enregistré et activé');
      window._beQcmEditingId = null;
      beCloseQcmConfig();
      renderWellbeing();
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message));
    }
  };

  window.beCloseSurvey = async function (id) {
    if (!confirm('Clôturer ce sondage ? Les collaborateurs ne pourront plus répondre.')) return;
    try {
      await api.wellbeingCloseSurvey(id);
      if (typeof showToast === 'function') showToast('✅ Sondage clôturé');
      window._beQcmEditingId = null;
      beCloseQcmConfig();
      renderWellbeing();
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message));
    }
  };

  window.beActivateSurvey = async function (id) {
    try {
      await api.wellbeingActivateSurvey(id);
      if (typeof showToast === 'function') showToast('✅ Sondage activé');
      beCloseQcmConfig();
      renderWellbeing();
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message));
    }
  };

  window.beCreateSurveyDraft = async function () {
    const start = beMonday(new Date());
    const label = 'Semaine du ' + start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    try {
      const { survey } = await api.wellbeingCreateSurvey({
        weekStart: start.toISOString(),
        weekLabel: label,
        durationDays: 7,
        onlyOnWorkShifts: true,
        isCustom: true,
        questions: beDefaultSurveyQuestions(),
      });
      if (typeof showToast === 'function') showToast('✅ Brouillon créé — personnalisez puis activez');
      if (survey?.id) await window.beEditSurvey(survey.id);
    } catch (e) {
      if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message));
    }
  };

  function saveEntretien(entry) {
    const list = JSON.parse(localStorage.getItem(ENT_KEY) || '[]');
    list.unshift({ ...entry, id: Date.now(), createdAt: new Date().toISOString() });
    localStorage.setItem(ENT_KEY, JSON.stringify(list.slice(0, 50)));
  }

  function openPlanifierEntretien(opts) {
    if (typeof opts === 'string') opts = { team: opts };
    opts = opts || {};
    const presetTeam = opts.team || window.currentTeamDetailName || '';
    const presetSite = opts.siteId || window.currentTeamDetailSiteId || '';

    document.getElementById('be-entretien-modal')?.remove();

    const teams = window.wellbeingTeams || [];
    let equipeField;
    if (teams.length) {
      const optsHtml = '<option value="">— Choisir une équipe —</option>'
        + teams.map((t) => {
          const sel = presetTeam && t.name === presetTeam ? ' selected' : '';
          return `<option value="${esc(t.name)}" data-site-id="${esc(t.siteId || '')}"${sel}>${esc(t.name)}</option>`;
        }).join('');
      equipeField = `<select class="form-input" id="entretien-equipe">${optsHtml}</select>`;
    } else {
      equipeField = `<input type="text" class="form-input" id="entretien-equipe" placeholder="Nom de l'équipe / site" value="${esc(presetTeam)}">`;
    }

    const today = new Date().toISOString().split('T')[0];
    const modal = document.createElement('div');
    modal.id = 'be-entretien-modal';
    modal.className = 'modal-overlay';
    modal.style.cssText = 'display:flex;z-index:500';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:440px">
        <div class="modal-header">
          <div class="modal-title">Planifier un point manager</div>
          <div class="modal-header-close" role="button" tabindex="0" aria-label="Fermer">✕</div>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Équipe / site</label>
            ${equipeField}
          </div>
          <div class="form-group">
            <label class="form-label">Date</label>
            <input type="date" class="form-input" id="entretien-date" min="${today}">
          </div>
          <div class="form-group">
            <label class="form-label">Heure</label>
            <input type="time" class="form-input" id="entretien-heure" value="10:00">
          </div>
          <div class="form-group">
            <label class="form-label">Type</label>
            <select class="form-input" id="entretien-type">
              <option>Point manager bien-être</option>
              <option>Entretien bien-être</option>
              <option>Entretien de retour absence</option>
              <option>Entretien de recadrage</option>
              <option>Autre</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Note (optionnel)</label>
            <textarea class="form-input" id="entretien-note" rows="3" placeholder="Contexte, points à aborder…" style="resize:vertical;min-height:70px"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" data-be-modal-cancel>Annuler</button>
          <button type="button" class="btn btn-primary" id="entretien-confirm-btn">Planifier</button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    const equipeEl = document.getElementById('entretien-equipe');
    if (equipeEl?.tagName === 'SELECT' && presetSite) {
      const opt = [...equipeEl.options].find((o) => o.dataset.siteId === presetSite);
      if (opt) equipeEl.value = opt.value;
    }

    const close = () => modal.remove();
    modal.querySelector('.modal-header-close')?.addEventListener('click', close);
    modal.querySelector('[data-be-modal-cancel]')?.addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    document.getElementById('entretien-confirm-btn')?.addEventListener('click', () => {
      confirmPlanifierEntretien(close);
    });

    window._beEntretienPresetSite = presetSite;
  }

  function confirmPlanifierEntretien(onClose) {
    const date = document.getElementById('entretien-date')?.value;
    const heure = document.getElementById('entretien-heure')?.value || '10:00';
    const type = document.getElementById('entretien-type')?.value || 'Point manager bien-être';
    const note = document.getElementById('entretien-note')?.value?.trim() || '';
    const equipeEl = document.getElementById('entretien-equipe');
    let equipe = '';
    let siteId = window._beEntretienPresetSite || window.currentTeamDetailSiteId || null;
    if (equipeEl?.tagName === 'SELECT') {
      equipe = equipeEl.value;
      const opt = equipeEl.selectedOptions?.[0];
      if (opt?.dataset?.siteId) siteId = opt.dataset.siteId;
    } else {
      equipe = equipeEl?.value?.trim() || '';
    }

    if (!date) {
      if (typeof showToast === 'function') showToast('⚠️ Choisissez une date');
      return;
    }
    if (!equipe) {
      if (typeof showToast === 'function') showToast('⚠️ Indiquez l\'équipe concernée');
      return;
    }

    const when = new Date(date + 'T' + (heure || '10:00'));
    const label = when.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
      + ' à ' + (heure || '10:00').slice(0, 5);

    (async () => {
      try {
        if (api.wellbeingCreateMeeting) {
          await api.wellbeingCreateMeeting({
            teamLabel: equipe,
            siteId: siteId || undefined,
            scheduledAt: when.toISOString(),
            type,
            note,
          });
        } else {
          saveEntretien({ date, heure, type, note, equipe, siteId });
        }
        if (typeof onClose === 'function') onClose();
        else document.getElementById('be-entretien-modal')?.remove();
        if (typeof showToast === 'function') {
          showToast('✅ Point manager planifié — ' + equipe + ' · ' + label + ' (visible dans Flux & Actions)');
        }
        if (typeof window.loadFluxPage === 'function') window.loadFluxPage();
      } catch (e) {
        if (typeof showToast === 'function') showToast('⚠️ ' + (e.error || e.message));
      }
    })();

    if (typeof window.closeTeamDetail === 'function') {
      try { window.closeTeamDetail(); } catch (_e) { /* panel may be closed */ }
    }
  }

  function bindConseilsActions() {
    const el = document.getElementById('be-ia-conseils');
    if (!el || el.dataset.beBound) return;
    el.dataset.beBound = '1';
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-be-action]');
      if (!btn) return;
      e.preventDefault();
      const action = btn.getAttribute('data-be-action');
      if (action === 'planifier-entretien') {
        openPlanifierEntretien({
          team: btn.getAttribute('data-team') || undefined,
          siteId: btn.getAttribute('data-site-id') || undefined,
        });
      } else if (action === 'planning') {
        if (typeof showPage === 'function') {
          showPage('planning', document.querySelector('.nav-item[onclick*="planning"]'));
        }
      }
    });
  }

  function patchScatterAbsRate() {
    if (typeof window.teamAbsRateForScatter !== 'function') return;
    const orig = window.teamAbsRateForScatter;
    window.teamAbsRateForScatter = function (name, score) {
      const t = (window.wellbeingTeams || []).find((x) => x.name === name);
      if (t?.absenceRate != null) return t.absenceRate;
      return orig(name, score);
    };
  }

  function init() {
    window._beOrigOpenTeamDetail = window.openTeamDetail;
    window.renderWellbeing = beRenderWellbeing;
    window.openTeamDetail = beOpenTeamDetail;
    window.downloadRapportBienetre = downloadCsv;
    window.openQCMConfig = openQcmConfigModal;
    window.planifierEntretien = openPlanifierEntretien;
    window.confirmEntretien = function (btn) {
      confirmPlanifierEntretien(() => btn?.closest?.('.modal-overlay')?.remove());
    };
    patchScatterAbsRate();
    patchScatterInsight();
    bindConseilsActions();
    window.renderWellbeingTable = renderBeQcmTable;

    if (typeof applyAuthenticatedSession === 'function' && !applyAuthenticatedSession.__beScopeChained) {
      const origApply = applyAuthenticatedSession;
      window.applyAuthenticatedSession = function (user) {
        origApply(user);
        if (user?.role === 'MANAGER') applyManagerBienetreUI();
      };
      applyAuthenticatedSession.__beScopeChained = true;
    }

    if (isManagerBienetreScoped()) applyManagerBienetreUI();

    const origDrhBody = window.renderWellbeingDrhBody;
    if (origDrhBody) {
      window.renderWellbeingDrhBody = function () {
        if (!window.__beAllSites?.length && !window.wellbeingTeams?.length) {
          origDrhBody();
        }
        renderBeTeamsGrid();
        renderBeQcmTable();
        renderConseilsList(buildDynamicConseils());
        bindConseilsActions();
      };
    }
  }

  window.planifierEntretien = openPlanifierEntretien;
  window.confirmEntretien = function (btn) {
    confirmPlanifierEntretien(() => btn?.closest?.('.modal-overlay')?.remove());
  };

  window.isManagerBienetreScoped = isManagerBienetreScoped;
  window.applyManagerBienetreUI = applyManagerBienetreUI;
  window.beResolveRole = beResolveRole;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
