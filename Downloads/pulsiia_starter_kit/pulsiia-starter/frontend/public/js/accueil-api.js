// accueil-api.js — Page d'accueil collaborateur branchée sur l'API
(function () {
  'use strict';

  let loading = false;
  let lastBulletinId = null;

  const ABS_STATUS_LABEL = {
    EN_ATTENTE: 'en attente de validation',
    APPROUVE: 'approuvée',
    REFUSE: 'refusée',
    ANNULE: 'annulée',
  };

  const ABS_TYPE_LABEL = {
    CP: 'congé payé',
    RTT: 'RTT',
    MALADIE: 'arrêt maladie',
    ACCIDENT_TRAVAIL: 'accident du travail',
    SANS_SOLDE: 'congé sans solde',
    FORMATION: 'formation',
    AUTRE: 'absence',
  };

  function isCollabUser() {
    const role = window.Auth?.user?.role || window.currentUser?.role;
    return role === 'COLLABORATEUR';
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatRelativeDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'À l\'instant';
    if (diffMin < 60) return 'Il y a ' + diffMin + ' min';
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return 'Il y a ' + diffH + ' h';
    const diffD = Math.floor(diffH / 24);
    if (diffD === 1) return 'Hier';
    if (diffD < 7) return 'Il y a ' + diffD + ' jours';
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatAbsPeriod(start, end) {
    if (!start) return '';
    const s = new Date(start + 'T12:00:00');
    const e = end ? new Date(end + 'T12:00:00') : s;
    const opts = { day: 'numeric', month: 'short' };
    if (s.getTime() === e.getTime()) return s.toLocaleDateString('fr-FR', opts);
    return s.toLocaleDateString('fr-FR', opts) + ' – ' + e.toLocaleDateString('fr-FR', opts);
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function renderHoursKpi(salary) {
    const valEl = document.getElementById('accueil-hours-month');
    const subEl = document.getElementById('accueil-hours-month-sub');
    if (!valEl) return;

    if (!salary?.hours) {
      valEl.innerHTML = '—<span style="font-size:13px;font-weight:400;color:var(--text-2)">h</span>';
      if (subEl) subEl.textContent = 'Données indisponibles';
      return;
    }

    const h = salary.hours;
    const total = Math.round(h.normal + h.night + h.sup125 + h.sup150);
    valEl.innerHTML = total + '<span style="font-size:13px;font-weight:400;color:var(--text-2)">h</span>';

    if (subEl) {
      const parts = [];
      if (h.night > 0) parts.push('Dont ' + Math.round(h.night) + 'h nuit');
      if (h.sup125 + h.sup150 > 0) parts.push(Math.round(h.sup125 + h.sup150) + 'h sup.');
      subEl.textContent = parts.length ? parts.join(' · ') : 'Heures normales ce mois';
    }
  }

  function renderLeaveKpi(balance) {
    const valEl = document.getElementById('accueil-leave-balance');
    const subEl = document.getElementById('accueil-leave-sub');
    if (!valEl) return;

    if (!balance?.cp) {
      valEl.innerHTML = '—<span style="font-size:13px;font-weight:400;color:var(--text-2)"> jours</span>';
      if (subEl) subEl.textContent = 'Solde indisponible';
      return;
    }

    const cpRem = balance.cp.remaining ?? 0;
    const rttRem = balance.rtt?.remaining ?? 0;
    const total = Math.round((cpRem + rttRem) * 10) / 10;

    valEl.innerHTML = total + '<span style="font-size:13px;font-weight:400;color:var(--text-2)"> jours</span>';
    if (subEl) {
      subEl.textContent = rttRem > 0 ? 'Dont ' + rttRem + ' RTT' : 'Congés payés restants';
    }
  }

  function renderWellbeingKpi(team) {
    const valEl = document.getElementById('accueil-wellbeing-score');
    const subEl = document.getElementById('accueil-wellbeing-sub');
    if (!valEl) return;

    if (!team?.available || team.score == null) {
      valEl.innerHTML = '—<span style="font-size:13px;font-weight:400;color:var(--text-2)">/10</span>';
      if (subEl) {
        subEl.textContent = team?.message || 'Score équipe indisponible';
        subEl.style.color = 'var(--text-3)';
      }
      return;
    }

    const score = Math.round(team.score * 10) / 10;
    valEl.innerHTML = score + '<span style="font-size:13px;font-weight:400;color:var(--text-2)">/10</span>';

    if (subEl) {
      const delta = team.trendDelta;
      if (delta == null || delta === 0) {
        subEl.textContent = 'Stable';
        subEl.style.color = 'var(--text-2)';
      } else if (delta > 0) {
        subEl.textContent = '↑ En hausse';
        subEl.style.color = 'var(--green)';
      } else {
        subEl.textContent = '↓ En baisse';
        subEl.style.color = 'var(--orange)';
      }
    }
  }

  function renderLastBulletin(documents, salary) {
    const el = document.getElementById('accueil-last-bulletin');
    if (!el) return;

    const bulletins = (documents || []).filter(function (d) { return d.cat === 'bulletin'; });
    const doc = bulletins[0];

    if (doc) {
      lastBulletinId = doc.id;
      const period = doc.name.replace(/^Bulletin de paie — /i, '').replace(/^Bulletin /i, '') || doc.date;
      const net = salary?.net != null ? Math.round(salary.net).toLocaleString('fr-FR') + ' €' : '—';
      const brut = salary?.brut != null ? Math.round(salary.brut).toLocaleString('fr-FR') + ' €' : '—';
      el.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg);border-radius:8px">' +
        '<span style="font-size:24px">🧾</span>' +
        '<div style="flex:1">' +
        '<div style="font-size:13px;font-weight:600">' + escapeHtml(period) + '</div>' +
        '<div style="font-size:12px;color:var(--text-2);margin-top:1px">Net : <strong style="color:var(--green)">' + net + '</strong> · Brut : ' + brut + '</div>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost" style="padding:5px 10px;font-size:12px" data-doc-id="' + escapeHtml(doc.id) + '" onclick="downloadBulletin(this)">↓ PDF</button>' +
        '</div>';
      return;
    }

    lastBulletinId = null;
    if (salary?.net != null) {
      const periodLabel = salary.period
        ? new Date(salary.period + '-01').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
        : 'Ce mois';
      el.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg);border-radius:8px">' +
        '<span style="font-size:24px">🧾</span>' +
        '<div style="flex:1">' +
        '<div style="font-size:13px;font-weight:600">' + escapeHtml(periodLabel.charAt(0).toUpperCase() + periodLabel.slice(1)) + '</div>' +
        '<div style="font-size:12px;color:var(--text-2);margin-top:1px">Net estimé : <strong style="color:var(--green)">' +
        Math.round(salary.net).toLocaleString('fr-FR') + ' €</strong> · Brut : ' +
        Math.round(salary.brut).toLocaleString('fr-FR') + ' €</div>' +
        '</div>' +
        '<button type="button" class="btn btn-ghost" style="padding:5px 10px;font-size:12px" onclick="showPage(\'mon-salaire\',document.querySelector(\'.nav-item[onclick*=mon-salaire]\'))">Voir →</button>' +
        '</div>';
    } else {
      el.innerHTML = '<div style="font-size:13px;color:var(--text-3);padding:8px 4px">Aucun bulletin disponible</div>';
    }
  }

  function renderNotifications(absences, documents) {
    const el = document.getElementById('accueil-notifications-list');
    if (!el) return;

    const items = [];

    (absences || []).slice(0, 5).forEach(function (a) {
      const status = a.status || 'EN_ATTENTE';
      const typeLabel = ABS_TYPE_LABEL[a.type] || 'demande';
      const period = formatAbsPeriod(a.startDate, a.endDate);
      let dotColor = 'var(--blue)';
      let text = '';
      let action = '';
      let actionLabel = 'Voir →';

      if (status === 'REFUSE') {
        dotColor = 'var(--red)';
        text = 'Votre demande de ' + typeLabel + ' du ' + period + ' a été <strong>refusée</strong>';
        if (a.refuseReason) text += '';
        action = "showPage('mes-docs',document.querySelector('.nav-item[onclick*=mes-docs]'))";
      } else if (status === 'APPROUVE') {
        dotColor = 'var(--green)';
        text = 'Votre ' + typeLabel + ' du ' + period + ' a été <strong>approuvée</strong>';
        action = "showPage('mon-planning',document.querySelector('.nav-item[onclick*=mon-planning]'))";
      } else {
        dotColor = 'var(--orange)';
        text = 'Votre demande de ' + typeLabel + ' du ' + period + ' est <strong>en attente</strong>';
        action = "openDemandeModal()";
        actionLabel = 'Suivre →';
      }

      const sub = status === 'REFUSE' && a.refuseReason
        ? 'Motif : ' + a.refuseReason + ' · ' + formatRelativeDate(a.updatedAt || a.createdAt)
        : formatRelativeDate(a.updatedAt || a.createdAt);

      items.push({
        sortDate: a.updatedAt || a.createdAt,
        html:
          '<div style="display:flex;align-items:flex-start;gap:12px;padding:13px 20px;border-bottom:1px solid var(--border)">' +
          '<div style="width:8px;height:8px;border-radius:50%;background:' + dotColor + ';flex-shrink:0;margin-top:4px"></div>' +
          '<div style="flex:1">' +
          '<div style="font-size:13px;color:var(--text)">' + text + '</div>' +
          '<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">' + escapeHtml(sub) + '</div>' +
          '</div>' +
          '<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px;flex-shrink:0" onclick="' + action + '">' + actionLabel + '</button>' +
          '</div>',
      });
    });

    (documents || []).filter(function (d) { return d.cat === 'bulletin'; }).slice(0, 2).forEach(function (d, idx) {
      items.push({
        sortDate: Date.now() - idx,
        html:
          '<div style="display:flex;align-items:flex-start;gap:12px;padding:13px 20px;border-bottom:1px solid var(--border)">' +
          '<div style="width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;margin-top:4px"></div>' +
          '<div style="flex:1">' +
          '<div style="font-size:13px;color:var(--text)">Votre bulletin de paie <strong>' + escapeHtml(d.name.replace(/^Bulletin de paie — /i, '').replace(/^Bulletin /i, '')) + '</strong> est disponible</div>' +
          '<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">' + escapeHtml(d.date || '') + '</div>' +
          '</div>' +
          '<button type="button" class="btn btn-ghost" style="padding:4px 10px;font-size:12px;flex-shrink:0" data-doc-id="' + escapeHtml(d.id) + '" onclick="downloadBulletin(this)">↓ PDF</button>' +
          '</div>',
      });
    });

    if (!items.length) {
      el.innerHTML = '<div style="padding:20px;font-size:13px;color:var(--text-3);text-align:center">Aucune notification récente</div>';
      return;
    }

    items.sort(function (a, b) {
      return new Date(b.sortDate || 0) - new Date(a.sortDate || 0);
    });

    el.innerHTML = items.slice(0, 5).map(function (i) { return i.html; }).join('');
  }

  async function loadAccueilCollab() {
    if (!isCollabUser() || loading) return;
    if (typeof api === 'undefined') return;

    loading = true;
    const year = new Date().getFullYear();
    const period = new Date().toISOString().slice(0, 7);

    const planningTask = (async function () {
      try {
        if (typeof loadPlanningWeekFromApi === 'function') {
          await loadPlanningWeekFromApi(0, true);
        } else if (typeof ensurePlanningApiReady === 'function') {
          await ensurePlanningApiReady(true);
        }
      } catch (err) {
        console.warn('[accueil-api] planning:', err.error || err.message || err);
      } finally {
        window.__accueilPlanningAttempted = true;
        if (typeof renderAccueilWorkDays === 'function') renderAccueilWorkDays();
      }
    })();

    try {
      await planningTask;

      const results = await Promise.allSettled([
        typeof loadSurveyForQcm === 'function' ? loadSurveyForQcm() : Promise.resolve(),
        api.absencesBalance(null, year),
        api.mySalary(period),
        api.wellbeingMyTeam(),
        api.absences(),
        api.myDocuments(),
      ]);

      const balance = results[1].status === 'fulfilled' ? results[1].value : null;
      const salary = results[2].status === 'fulfilled' ? results[2].value : null;
      const team = results[3].status === 'fulfilled' ? results[3].value : null;
      const absences = results[4].status === 'fulfilled' ? (results[4].value.absences || []) : [];
      const docs = results[5].status === 'fulfilled' ? (results[5].value.documents || []) : [];

      window.__monPlanApprovedAbsences = absences.filter(function (a) {
        return a.status === 'APPROUVE';
      });

      renderHoursKpi(salary);
      renderLeaveKpi(balance);
      renderWellbeingKpi(team);
      renderLastBulletin(docs, salary);
      renderNotifications(absences, docs);

      if (typeof renderAccueilWorkDays === 'function') renderAccueilWorkDays();
      if (typeof syncAccueilQcmAvailability === 'function') syncAccueilQcmAvailability();
    } catch (err) {
      console.warn('[accueil-api]', err.error || err.message || err);
      renderHoursKpi(null);
      renderLeaveKpi(null);
      renderWellbeingKpi(null);
      if (typeof renderAccueilWorkDays === 'function') renderAccueilWorkDays();
    } finally {
      loading = false;
    }
  }

  function patchShowPage() {
    if (typeof showPage !== 'function' || showPage.__accueilApiPatched) return;
    const orig = showPage;
    window.showPage = function (name, navEl) {
      orig(name, navEl);
      if (name === 'accueil-collab' && isCollabUser()) {
        loadAccueilCollab();
      }
    };
    showPage.__accueilApiPatched = true;
  }

  function patchOpenQcmFromAccueil() {
    if (typeof openQcmFromAccueil !== 'function' || window.__openQcmAccueilPatched) return;
    const orig = openQcmFromAccueil;
    window.openQcmFromAccueil = async function () {
      await orig();
      if (window.qcmDone) return;
      if (typeof isQcmFillable === 'function' && !isQcmFillable()) {
        const avail = window.__qcmAvailability;
        const reason = avail?.reason;
        let msg = 'Le QCM n\'est pas disponible pour le moment.';
        if (reason === 'NO_WORK_TODAY') msg = 'Pas de QCM aujourd\'hui — vous n\'avez pas de shift planifié.';
        else if (reason === 'ALREADY_ANSWERED') msg = 'Vous avez déjà répondu au QCM du jour.';
        else if (avail?.message) msg = avail.message;
        if (typeof showToast === 'function') showToast(msg);
      }
    };
    window.__openQcmAccueilPatched = true;
  }

  function patchDownloadBulletin() {
    if (typeof downloadBulletin !== 'function' || window.__downloadBulletinPatched) return;
    window.downloadBulletin = async function (btn) {
      const docId = btn?.dataset?.docId || lastBulletinId;
      if (docId && typeof api?.downloadDocument === 'function') {
        try {
          await api.downloadDocument(docId);
          if (typeof showToast === 'function') showToast('📥 Téléchargement démarré ✓');
        } catch (err) {
          if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur de téléchargement');
        }
        return;
      }
      const row = btn?.closest('tr');
      const period = row?.querySelector('td')?.textContent?.trim() || 'bulletin';
      if (typeof showToast === 'function') showToast('📥 Bulletin ' + period + ' — téléchargement démarré ✓');
    };
    window.__downloadBulletinPatched = true;
  }

  function patchSubmitTransport() {
    if (typeof submitTransport !== 'function' || window.__submitTransportPatched) return;
    window.submitTransport = async function () {
      const typeEl = document.getElementById('tr-type');
      const montantEl = document.getElementById('tr-montant');
      const periodeEl = document.getElementById('tr-periode');
      if (!typeEl?.value) { if (typeof showToast === 'function') showToast('⚠️ Veuillez sélectionner un type de transport'); return; }
      if (!montantEl?.value) { if (typeof showToast === 'function') showToast('⚠️ Veuillez indiquer le montant'); return; }

      const label = typeEl.options[typeEl.selectedIndex]?.text || typeEl.value;
      const periode = periodeEl?.value || '';
      const file = window.__trPendingFile;

      try {
        if (file && typeof api.uploadMyDocument === 'function') {
          await api.uploadMyDocument(file, 'Transport ' + label + (periode ? ' — ' + periode : ''));
        }
        if (typeof closeModal === 'function') closeModal('modal-transport');
        typeEl.value = '';
        montantEl.value = '';
        if (periodeEl) periodeEl.value = '';
        const pjName = document.getElementById('tr-pj-name');
        if (pjName) pjName.textContent = '';
        window.__trPendingFile = null;
        const comment = document.getElementById('tr-comment');
        if (comment) comment.value = '';
        if (typeof showToast === 'function') showToast('🚌 Demande de remboursement envoyée aux RH ✓');
        loadAccueilCollab();
      } catch (err) {
        if (typeof showToast === 'function') showToast(err.error || err.message || 'Erreur lors de l\'envoi');
      }
    };
    window.__submitTransportPatched = true;
  }

  function patchSimUploadTransport() {
    if (typeof simUploadTransport !== 'function' || window.__simUploadTransportPatched) return;
    window.simUploadTransport = function () {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.pdf,.jpg,.jpeg,.png,.webp';
      inp.onchange = function (e) {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > 10 * 1024 * 1024) {
          if (typeof showToast === 'function') showToast('❌ Fichier trop volumineux (max 10 Mo)');
          return;
        }
        window.__trPendingFile = file;
        const pjName = document.getElementById('tr-pj-name');
        if (pjName) pjName.innerHTML = '✅ ' + escapeHtml(file.name) + ' — prêt à envoyer';
      };
      inp.click();
    };
    window.__simUploadTransportPatched = true;
  }

  function patchSyncQcmDoneState() {
    if (window.__syncQcmAccueilPatched) return;
    const orig = window.syncQcmDoneState;
    window.syncQcmDoneState = function (done) {
      if (typeof orig === 'function') orig(done);
      if (typeof syncAccueilQcmAvailability === 'function') syncAccueilQcmAvailability();
    };
    window.__syncQcmAccueilPatched = true;
  }

  function patchSaveDemandeRefresh() {
    if (typeof saveDemande !== 'function' || window.__saveDemandeAccueilPatched) return;
    const orig = saveDemande;
    window.saveDemande = async function () {
      const modal = document.getElementById('modal-demande');
      const wasOpen = modal?.classList.contains('open');
      await orig();
      if (wasOpen && !modal?.classList.contains('open') && isCollabUser()) {
        loadAccueilCollab();
      }
    };
    window.__saveDemandeAccueilPatched = true;
  }

  function patchApplySession() {
    if (typeof applyAuthenticatedSession !== 'function' || applyAuthenticatedSession.__accueilPatched) return;
    const orig = applyAuthenticatedSession;
    window.applyAuthenticatedSession = function (user) {
      orig(user);
      if (user?.role === 'COLLABORATEUR') {
        loadAccueilCollab();
      }
    };
    applyAuthenticatedSession.__accueilPatched = true;
  }

  function deferInit() {
    if (typeof showPage !== 'function') {
      setTimeout(deferInit, 40);
      return;
    }
    patchShowPage();
    patchOpenQcmFromAccueil();
    patchDownloadBulletin();
    patchSubmitTransport();
    patchSimUploadTransport();
    patchSyncQcmDoneState();
    patchSaveDemandeRefresh();
    patchApplySession();

    if (isCollabUser() && document.getElementById('page-accueil-collab')?.classList.contains('active')) {
      loadAccueilCollab();
    }
  }

  window.loadAccueilCollab = loadAccueilCollab;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', deferInit);
  } else {
    deferInit();
  }
})();
