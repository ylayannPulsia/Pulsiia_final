// qcm-api.js — QCM journalier : sondage API, stats, historique, rappel
(function () {
  'use strict';

  const EMOJIS = ['😊', '⚡', '👥', '🛠️', '💬', '💭'];
  const HINTS = [
    'Prenez un instant pour évaluer votre ressenti.',
    '1 = pas du tout · 10 = tout à fait',
    'Votre réponse est anonyme.',
  ];
  const REMINDER_KEY = 'pulsiia_qcm_reminder';

  function buildQuestionsFromSurvey(survey) {
    if (!survey?.questions?.length) return null;
    const n = survey.questions.length;
    return survey.questions.map(function (q, i) {
      if (q.type === 'TEXT') {
        return {
          id: q.id,
          type: 'text',
          pct: Math.round(((i + 1) / n) * 95),
          label: q.text,
          hint: q.optional
            ? 'Facultatif — partagez une remarque anonyme si vous le souhaitez.'
            : 'Votre réponse est anonyme.',
          emoji: '💬',
          placeholder: 'Ex. charge de travail, ambiance, suggestion…',
          optional: Boolean(q.optional),
        };
      }
      return {
        id: q.id,
        type: 'scale',
        scoreDirect: true,
        scaleMinLabel: 'Pas du tout',
        scaleMaxLabel: 'Tout à fait',
        pct: Math.round(((i + 1) / n) * 95),
        label: q.text,
        hint: HINTS[i] || 'Notez de 1 (minimum) à 10 (maximum)',
        emoji: EMOJIS[i % EMOJIS.length],
        min: 1,
        max: 10,
      };
    });
  }

  function setQcmDone(done) {
    window.qcmDone = Boolean(done);
    if (typeof window.syncQcmDoneState === 'function') window.syncQcmDoneState(done);
  }

  function dayShort(d) {
    const labels = ['D', 'L', 'Ma', 'Me', 'J', 'V', 'S'];
    return labels[d.getDay()];
  }

  function buildLast7DaysHistory(apiHistory) {
    const byDate = new Map();
    (apiHistory || []).forEach(function (h) {
      const d = new Date(h.responseDate || h.date || h.weekStart);
      if (Number.isNaN(d.getTime())) return;
      const key = localDateKey(d);
      if (!byDate.has(key)) {
        byDate.set(key, { day: h.day || dayShort(d), score: h.score, done: true, date: key });
      }
    });

    const days = [];
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const key = localDateKey(d);
      const hit = byDate.get(key);
      days.push(
        hit || { day: dayShort(d), score: null, done: false, date: key, isToday: i === 0 },
      );
    }
    return days;
  }

  function computeStreak(days) {
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      if (days[i].done) streak++;
      else break;
    }
    return streak;
  }

  function computeAvg4Weeks(apiHistory, personalHistory) {
    const scores = [];
    (personalHistory || []).forEach(function (p) {
      if (p.score != null) scores.push(p.score);
    });
    if (!scores.length && apiHistory?.length) {
      apiHistory.slice(0, 4).forEach(function (h) {
        if (h.score != null) scores.push(h.score);
      });
    }
    if (!scores.length) return null;
    const sum = scores.reduce(function (a, b) { return a + b; }, 0);
    return Math.round((sum / scores.length) * 10) / 10;
  }

  function updateQcmStatsUI(opts) {
    const partEl = document.getElementById('qcm-stat-participation');
    const streakEl = document.getElementById('qcm-stat-streak');
    const avgEl = document.getElementById('qcm-stat-avg');
    const avgLabel = document.getElementById('qcm-stat-avg-label');
    const badge = document.getElementById('qcm-status-badge');
    const resetBtn = document.getElementById('btn-reset-qcm');

    if (partEl) {
      if (opts.participation != null) {
        partEl.textContent = opts.participation + '%';
        partEl.title = '';
      } else if (opts.noWorkToday && !opts.done) {
        partEl.innerHTML = '<span style="font-size:14px;color:#94a3b8">N/A</span>';
        partEl.title = 'Non applicable les jours sans travail';
      } else if (!opts.done) {
        partEl.innerHTML = '<span style="font-size:14px;color:#94a3b8">—</span>';
        partEl.title = opts.statsUnavailable
          ? 'Données équipe indisponibles (vérifiez la connexion API)'
          : 'Participation non calculée';
      }
    }
    if (streakEl && opts.streak != null) {
      streakEl.innerHTML =
        opts.streak +
        ' <span style="font-size:13px;font-weight:400;color:var(--text-2)">jours</span>';
      if (typeof window.qcmStreak !== 'undefined') window.qcmStreak = opts.streak;
    }
    if (avgLabel) {
      avgLabel.textContent = opts.done && window.__qcmLastScore != null
        ? 'Votre score du jour'
        : 'Score moyen (4 sem.)';
    }
    if (avgEl) {
      if (opts.done && window.__qcmLastScore != null) {
        avgEl.innerHTML =
          window.__qcmLastScore +
          ' <span style="font-size:13px;font-weight:400;color:var(--text-2)">/10</span>';
        avgEl.title = 'Votre score du jour';
      } else if (opts.avg != null) {
        avgEl.innerHTML =
          opts.avg +
          ' <span style="font-size:13px;font-weight:400;color:var(--text-2)">/10</span>';
        avgEl.title = 'Moyenne sur 4 semaines';
      } else if (opts.noWorkToday && !opts.done) {
        avgEl.innerHTML =
          '— <span style="font-size:13px;font-weight:400;color:var(--text-2)">/10</span>';
      } else if (!opts.done) {
        avgEl.innerHTML =
          '— <span style="font-size:13px;font-weight:400;color:var(--text-2)">/10</span>';
        avgEl.title = opts.statsUnavailable
          ? 'Historique indisponible sans API'
          : 'Pas encore de moyenne sur 4 semaines';
      }
    }
    if (badge) {
      if (opts.done) {
        badge.className = 'status-badge ok';
        badge.innerHTML = '<span class="status-dot"></span>Répondu aujourd\'hui';
        if (resetBtn) resetBtn.style.display = 'none';
      } else if (opts.unavailable) {
        badge.className = 'status-badge';
        badge.style.background = opts.noWorkToday ? '#F1F5F9' : 'var(--bg)';
        badge.style.color = opts.noWorkToday ? '#64748B' : 'var(--text-2)';
        let badgeText = 'Non disponible';
        if (opts.noWorkToday) badgeText = 'Pas de travail aujourd\'hui';
        else if (opts.unavailReason === 'NOT_STARTED') badgeText = 'Pas encore ouvert';
        else if (opts.unavailReason === 'ENDED') badgeText = 'Période terminée';
        else if (opts.unavailReason === 'NO_SURVEY') badgeText = 'Aucun sondage actif';
        badge.innerHTML = '<span class="status-dot"></span>' + badgeText;
        if (resetBtn) resetBtn.style.display = 'none';
      } else {
        badge.className = 'status-badge warn';
        badge.innerHTML =
          '<span class="status-dot"></span>En attente de votre réponse';
        if (resetBtn) resetBtn.style.display = 'none';
      }
    }

    const label = document.getElementById('qcm-date-label');
    if (label && !label.dataset.apiLabel) {
      const now = new Date();
      const fmt = now.toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
      label.textContent = fmt.charAt(0).toUpperCase() + fmt.slice(1) + ' · Réponses anonymes';
    }
  }

  async function loadQcmHistoryFromApi() {
    if (!window.api?.myQcmHistory || typeof window.qcmHistory === 'undefined') return [];
    try {
      const { history } = await api.myQcmHistory();
      const days = buildLast7DaysHistory(history);
      window.qcmHistory = days;
      if (typeof window.renderQCMHistory === 'function') window.renderQCMHistory();
      return history || [];
    } catch (_e) {
      return [];
    }
  }

  function localDateKey(d) {
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function todayDateKey() {
    return localDateKey(new Date());
  }

  async function resolveTodayQcmScore() {
    const todayKey = todayDateKey();

    try {
      if (window.api?.myQcmHistory) {
        const { history } = await api.myQcmHistory();
        for (let i = 0; i < (history || []).length; i++) {
          const h = history[i];
          const d = new Date(h.responseDate || h.date || h.weekStart);
          if (Number.isNaN(d.getTime())) continue;
          if (localDateKey(d) === todayKey && h.score != null) {
            return h.score;
          }
        }
        if (window.qcmDone && history?.[0]?.score != null) {
          const first = history[0];
          const firstDay = localDateKey(new Date(first.responseDate || first.date || first.weekStart));
          if (firstDay === todayKey) return first.score;
        }
      }
    } catch (_e) { /* optional */ }

    const days = window.qcmHistory || [];
    const today = days.find(function (d) { return d.isToday && d.done; });
    if (today?.score != null) return today.score;

    return window.__qcmLastScore != null ? window.__qcmLastScore : null;
  }

  function getQcmUnavailableContent(reason, avail, hasSurvey) {
    const msg = avail?.message || '';
    const infoBox = function (title, items) {
      return (
        '<div style="width:100%;max-width:560px;margin:0 0 28px;text-align:left;background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px 22px">' +
        '<div style="font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px">' +
        title +
        '</div><ul style="margin:0;padding:0 0 0 18px;color:#475569;font-size:14px;line-height:1.7">' +
        items.map(function (li) { return '<li>' + li + '</li>'; }).join('') +
        '</ul></div>'
      );
    };

    if (reason === 'NO_WORK_TODAY') {
      return {
        title: 'Pas de QCM aujourd\'hui',
        body:
          'D\'après votre planning publié, vous n\'avez aucun shift de travail aujourd\'hui. Le QCM bien-être n\'est proposé que les jours où vous êtes planifié.',
        icon: '😴',
        extraCls: ' qcm-unavail-rest',
        infoBlock: infoBox('Pourquoi ?', [
          'Le QCM est réservé aux <strong>jours travaillés</strong> (matin, après-midi ou nuit).',
          'Les jours de <strong>repos</strong> ne déclenchent pas de questionnaire.',
          'Revenez lors de votre <strong>prochain shift planifié</strong>.',
        ]),
        showReminder: true,
      };
    }
    if (reason === 'NOT_STARTED') {
      return {
        title: 'Questionnaire pas encore ouvert',
        body: msg || 'Le sondage de cette semaine n\'a pas encore commencé. Revenez à la date indiquée par vos RH.',
        icon: '⏳',
        extraCls: ' qcm-unavail-scheduled',
        infoBlock: infoBox('À savoir', [
          'La période de réponse est définie par votre entreprise.',
          'Vous recevrez le QCM dès l\'ouverture si vous êtes planifié ce jour-là.',
        ]),
        showReminder: true,
      };
    }
    if (reason === 'ENDED') {
      return {
        title: 'Période de réponse terminée',
        body: msg || 'La fenêtre pour répondre à ce questionnaire est close. Un nouveau sondage pourra être lancé par vos RH.',
        icon: '🏁',
        extraCls: ' qcm-unavail-ended',
        infoBlock: infoBox('À savoir', [
          'Vos réponses passées restent comptabilisées de façon anonyme.',
          'Consultez l\'historique ci-dessus pour vos 7 derniers jours.',
        ]),
        showReminder: false,
      };
    }
    if (reason === 'NO_SURVEY' || !hasSurvey) {
      return {
        title: 'Aucun sondage actif',
        body:
          'Aucun questionnaire bien-être n\'est activé pour le moment. Vos RH peuvent en créer un depuis l\'espace Bien-être.',
        icon: '📋',
        extraCls: ' qcm-unavail-nosurvey',
        infoBlock: infoBox('En attendant', [
          'Cette page affichera le QCM dès qu\'un sondage sera <strong>publié et actif</strong>.',
          'L\'historique et les stats équipe se rempliront après les premières réponses.',
        ]),
        showReminder: true,
      };
    }
    return {
      title: 'Questionnaire indisponible',
      body: msg || window.__qcmUnavailableMessage || 'Le QCM n\'est pas accessible pour le moment.',
      icon: '📋',
      extraCls: '',
      infoBlock: '',
      showReminder: true,
    };
  }

  async function loadQcmPageStats() {
    let participation = null;
    let personalHistory = null;
    let avg = null;
    let teamApiOk = false;

    try {
      if (window.api?.wellbeingMyTeam) {
        const team = await api.wellbeingMyTeam();
        teamApiOk = true;
        if (team.available !== false && team.participationRate != null) {
          participation = team.participationRate;
        }
        personalHistory = team.personalHistory;
        if (team.qcmPending === false && !window.__qcmUnavailReason) {
          setQcmDone(true);
          if (typeof window.qcmShowValidatedBanner === 'function') {
            window.qcmShowValidatedBanner();
          }
        }
        if (window.qcmDone && personalHistory?.length) {
          const latest = personalHistory[0];
          if (latest?.score != null) window.__qcmLastScore = latest.score;
        }
      }
    } catch (_e) { /* optional */ }

    const apiHistory = await loadQcmHistoryFromApi();
    const days = window.qcmHistory || [];
    const streak = computeStreak(days);
    avg = computeAvg4Weeks(apiHistory, personalHistory);

    if (window.qcmDone) {
      const todayScore = await resolveTodayQcmScore();
      if (todayScore != null) window.__qcmLastScore = todayScore;
    }

    const reminder = localStorage.getItem(REMINDER_KEY);
    const reminderEl = document.getElementById('qcm-reminder-hint');
    if (reminderEl && reminder) {
      reminderEl.textContent = 'Rappel actif : ' + reminder;
      reminderEl.style.display = 'block';
    }

    const noWork = window.__qcmUnavailReason === 'NO_WORK_TODAY';
    const unavailable = Boolean(
      window.__qcmUnavailableMessage && !window.__qcmQuestions?.length && !window.qcmDone,
    );
    updateQcmStatsUI({
      participation: noWork && !window.qcmDone ? null : participation,
      streak: streak || (typeof window.qcmStreak === 'number' ? window.qcmStreak : 0),
      avg: noWork && !window.qcmDone ? null : avg,
      done: Boolean(window.qcmDone),
      unavailable: unavailable,
      noWorkToday: noWork,
      unavailReason: window.__qcmUnavailReason || null,
      statsUnavailable: !teamApiOk,
    });

    if (typeof window.updateQcmPageContext === 'function') {
      window.updateQcmPageContext();
    }
  }

  function ensureReminderModal() {
    let modal = document.getElementById('modal-qcm-reminder');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'modal-qcm-reminder';
    modal.className = 'modal-overlay';
    modal.innerHTML =
      '<div class="modal-box" style="max-width:400px">' +
      '  <div class="modal-header">' +
      '    <div class="modal-title">🔔 Rappel QCM</div>' +
      '    <div class="modal-header-close" onclick="closeModal(\'modal-qcm-reminder\')">✕</div>' +
      '  </div>' +
      '  <div class="modal-body" style="gap:14px">' +
      '    <p style="font-size:13px;color:var(--text-2);line-height:1.5">Recevez une notification pour compléter le QCM bien-être.</p>' +
      '    <div class="form-group">' +
      '      <label class="form-label">Heure du rappel</label>' +
      '      <select id="qcm-reminder-time" class="form-input">' +
      '        <option value="07:30">07h30</option>' +
      '        <option value="08:00" selected>08h00</option>' +
      '        <option value="09:00">09h00</option>' +
      '        <option value="12:00">12h00</option>' +
      '        <option value="17:00">17h00</option>' +
      '      </select>' +
      '    </div>' +
      '    <div class="form-group">' +
      '      <label class="form-label">Jours</label>' +
      '      <select id="qcm-reminder-days" class="form-input">' +
      '        <option value="weekdays">Jours ouvrés uniquement</option>' +
      '        <option value="daily" selected>Tous les jours</option>' +
      '      </select>' +
      '    </div>' +
      '  </div>' +
      '  <div class="modal-footer">' +
      '    <button type="button" class="btn btn-ghost" onclick="qcmCancelReminder()">Désactiver</button>' +
      '    <button type="button" class="btn btn-primary" onclick="qcmConfirmReminder()">Activer le rappel</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) {
      if (e.target === modal && typeof closeModal === 'function') {
        closeModal('modal-qcm-reminder');
      }
    });
    return modal;
  }

  window.planifierRappel = function planifierRappel() {
    const modal = ensureReminderModal();
    const saved = localStorage.getItem(REMINDER_KEY);
    if (saved) {
      try {
        const cfg = JSON.parse(saved);
        const t = document.getElementById('qcm-reminder-time');
        const d = document.getElementById('qcm-reminder-days');
        if (t && cfg.time) t.value = cfg.time;
        if (d && cfg.days) d.value = cfg.days;
      } catch (_e) { /* ignore */ }
    }
    modal.classList.add('open');
  };

  window.qcmConfirmReminder = function qcmConfirmReminder() {
    const time = document.getElementById('qcm-reminder-time')?.value || '08:00';
    const days = document.getElementById('qcm-reminder-days')?.value || 'daily';
    const label =
      'demain à ' +
      time.replace(':', 'h') +
      (days === 'weekdays' ? ' (jours ouvrés)' : '');
    localStorage.setItem(REMINDER_KEY, JSON.stringify({ time, days, enabled: true }));
    if (typeof closeModal === 'function') closeModal('modal-qcm-reminder');
    const hint = document.getElementById('qcm-reminder-hint');
    if (hint) {
      hint.textContent = 'Rappel actif : ' + label;
      hint.style.display = 'block';
    }
    if (typeof showToast === 'function') {
      showToast('🔔 Rappel planifié pour ' + label + ' ✓');
    }
  };

  window.qcmCancelReminder = function qcmCancelReminder() {
    localStorage.removeItem(REMINDER_KEY);
    if (typeof closeModal === 'function') closeModal('modal-qcm-reminder');
    const hint = document.getElementById('qcm-reminder-hint');
    if (hint) hint.style.display = 'none';
    if (typeof showToast === 'function') showToast('Rappel QCM désactivé');
  };

  /** Détection locale via le planning publié (fonctionne même si l'API échoue). */
  function detectNoWorkFromPlanning() {
    if (
      typeof getWeekDates !== 'function' ||
      typeof getPublishedShiftType !== 'function' ||
      typeof MON_PLAN_COLLAB_ID === 'undefined'
    ) {
      return null;
    }
    const offset = 0;
    const dates = getWeekDates(offset);
    const todayIdx = dates.findIndex(function (d) {
      return typeof isToday === 'function' && isToday(d);
    });
    if (todayIdx < 0) return null;
    const type = getPublishedShiftType(MON_PLAN_COLLAB_ID, todayIdx, offset);
    if (type === 'off' || type === 'empty' || type === 'absent') return 'NO_WORK_TODAY';
    return null;
  }

  function applyNoWorkState(reason) {
    if (reason !== 'NO_WORK_TODAY') return;
    window.__qcmUnavailReason = 'NO_WORK_TODAY';
    window.__qcmUnavailableMessage =
      'QCM non disponible : vous ne travaillez pas aujourd\'hui. Le questionnaire sera proposé lors de votre prochain jour planifié au travail.';
    window.__qcmQuestions = null;
    setQcmDone(false);
    window.__qcmLastScore = null;
    window.__qcmRespondedAt = null;
    if (typeof window.qcmHideValidatedBanner === 'function') window.qcmHideValidatedBanner();
    if (typeof window.resetQcmSession === 'function') window.resetQcmSession();
  }

  function patchLoadSurveyForQcm() {
    if (typeof loadSurveyForQcm !== 'function' || loadSurveyForQcm.__qcmApiPatched) return;

    const origLoad = loadSurveyForQcm;
    window.loadSurveyForQcm = async function () {
      window.__qcmQuestions = null;
      window.__qcmUnavailableMessage = null;
      window.__qcmUnavailReason = null;
      window.__qcmSurveyReady = false;
      window.activeSurvey = null;

      const wrap = document.getElementById('qcm-form-wrap');
      if (wrap && !window.qcmDone) {
        wrap.innerHTML =
          '<div class="qcm-card" style="min-height:200px;display:flex;align-items:center;justify-content:center">' +
          '<p style="color:#64748b;font-size:14px">Vérification de votre éligibilité au QCM…</p></div>';
      }

      await origLoad();

      try {
        if (window.api?.planningWeekAll && typeof loadPlanningWeekFromApi === 'function') {
          await loadPlanningWeekFromApi(0, false);
        }
      } catch (_e) { /* planning optionnel */ }

      const planningNoWork = detectNoWorkFromPlanning();
      if (planningNoWork) applyNoWorkState(planningNoWork);

      let survey = window.activeSurvey || null;
      window.__qcmAvailability = null;
      try {
        if (window.api?.currentSurvey) {
          const data = await api.currentSurvey();
          survey = data.survey;
          window.activeSurvey = survey;
          window.__qcmAvailability = data.availability || null;
          window.__qcmIsDailyRotation = survey?.isDailyRotation !== false && !survey?.isCustom;

          const blocked = data.availability?.available === false;
          const noWork = blocked && data.availability?.reason === 'NO_WORK_TODAY';
          if (planningNoWork && !noWork) applyNoWorkState('NO_WORK_TODAY');

          if (blocked || planningNoWork) {
            setQcmDone(false);
            window.__qcmRespondedAt = null;
            window.__qcmLastScore = null;
          } else if (data.hasResponded || data.alreadyAnswered) {
            setQcmDone(true);
            if (data.todayScore != null) window.__qcmLastScore = data.todayScore;
            if (data.respondedAt) window.__qcmRespondedAt = data.respondedAt;
          } else {
            setQcmDone(false);
            window.__qcmRespondedAt = null;
          }
        }
      } catch (_e) {
        if (planningNoWork) applyNoWorkState('NO_WORK_TODAY');
      }

      const avail = window.__qcmAvailability;
      if (!avail && planningNoWork) {
        applyNoWorkState('NO_WORK_TODAY');
      }
      const blocked =
        ((avail && avail.available === false && avail.reason !== 'NO_SURVEY') || planningNoWork);
      const canFill =
        !blocked && survey?.questions?.length;

      if (blocked && typeof window.resetQcmSession === 'function') {
        window.resetQcmSession();
      }

      if (canFill) {
        window.__qcmQuestions = buildQuestionsFromSurvey(survey);
        const label = document.getElementById('qcm-date-label');
        if (label) {
          let extra = '';
          if (survey.endsAt) {
            extra =
              ' · jusqu\'au ' +
              new Date(survey.endsAt).toLocaleDateString('fr-FR', {
                day: 'numeric',
                month: 'short',
              });
          }
          label.textContent =
            (survey.weekLabel || 'Semaine en cours') + extra + ' · Réponses anonymes';
          if (survey.isCustom) {
            label.textContent += ' · Sondage RH personnalisé';
          } else if (survey.isDailyRotation !== false) {
            label.textContent += ' · Questions du jour';
          }
          label.dataset.apiLabel = '1';
        }
        const sub = document.getElementById('be-qcm-subtitle');
        if (sub) {
          if (survey.isCustom) {
            sub.textContent = window.__qcmQuestions.length + ' question(s) · sondage RH personnalisé';
          } else {
            sub.textContent = window.__qcmQuestions.length + ' question(s) · QCM du jour (questions renouvelées chaque jour)';
          }
        }
      } else {
        window.__qcmQuestions = null;
        if (!survey && avail?.reason === 'NO_SURVEY') {
          // No active RH/manager survey: keep QCM fallback questions available.
          window.__qcmUnavailReason = null;
          window.__qcmUnavailableMessage = null;
        } else {
          window.__qcmUnavailReason = avail?.reason || 'UNAVAILABLE';
          if (avail?.reason === 'NO_WORK_TODAY') {
            window.__qcmUnavailableMessage =
              'QCM non disponible : vous ne travaillez pas aujourd\'hui. Le questionnaire sera proposé lors de votre prochain jour planifié au travail.';
          } else {
            window.__qcmUnavailableMessage =
              avail?.message ||
              'Questionnaire non disponible aujourd\'hui.';
          }
        }
      }

      window.__qcmSurveyReady = true;

      if (window.qcmDone) {
        const todayScore = await resolveTodayQcmScore();
        if (todayScore != null) window.__qcmLastScore = todayScore;
      }

      await loadQcmPageStats();
      if (typeof window.syncAccueilQcmAvailability === 'function') {
        window.syncAccueilQcmAvailability();
      }
      if (typeof window.updateQcmPageContext === 'function') {
        window.updateQcmPageContext();
      }

      if (window.__qcmSkipQuestionRender) return;

      if (window.qcmDone) {
        if (typeof renderQCMDone === 'function') {
          const score = await resolveTodayQcmScore();
          if (score != null) window.__qcmLastScore = score;
          renderQCMDone(window.__qcmLastScore ?? null);
          if (typeof window.qcmShowValidatedBanner === 'function') {
            window.qcmShowValidatedBanner();
          }
        }
      } else if (blocked) {
        if (typeof renderQcmUnavailable === 'function') renderQcmUnavailable();
      } else if (typeof renderQCMQuestion === 'function') {
        renderQCMQuestion();
      }
    };
    loadSurveyForQcm.__qcmApiPatched = true;
  }

  function patchShowPage() {
    if (typeof showPage !== 'function' || showPage.__qcmPagePatched) return;
    const original = showPage;
    window.showPage = function (name, navEl) {
      original(name, navEl);
      if (name === 'qcm' && typeof loadSurveyForQcm === 'function') {
        loadSurveyForQcm();
      }
    };
    showPage.__qcmPagePatched = true;
  }

  window.loadQcmPageStats = loadQcmPageStats;
  window.resolveTodayQcmScore = resolveTodayQcmScore;
  window.getQcmUnavailableContent = getQcmUnavailableContent;

  window.detectNoWorkFromPlanning = detectNoWorkFromPlanning;
  window.initQcmApi = function initQcmApi() {
    patchLoadSurveyForQcm();
    patchShowPage();
  };

  function bootQcmApi() {
    window.initQcmApi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootQcmApi, { once: true });
  } else {
    bootQcmApi();
  }
})();
