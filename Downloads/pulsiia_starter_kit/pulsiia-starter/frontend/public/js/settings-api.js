// settings-api.js — Paramètres entreprise (onglets, sauvegarde API, établissements)
(function () {
  'use strict';

  const TAB_MAP = {
    Entreprise: 'entreprise',
    Établissements: 'etablissements',
    'Planning & Shifts': 'planning',
    Notifications: 'notifications',
    Intégrations: 'integrations',
    'Sécurité & RGPD': 'securite',
  };

  const SHIFT_TEMPLATE_KEYS = ['MATIN', 'APREM', 'NUIT', 'JOURNEE'];
  const DAY_LABELS = [
    { v: 1, label: 'Lun' },
    { v: 2, label: 'Mar' },
    { v: 3, label: 'Mer' },
    { v: 4, label: 'Jeu' },
    { v: 5, label: 'Ven' },
    { v: 6, label: 'Sam' },
    { v: 0, label: 'Dim' },
  ];

  const NOTIF_TOGGLES = [
    { key: 'planningRealtime', label: 'Alertes planning temps réel', desc: 'Notification immédiate si un poste est découvert' },
    { key: 'prepaieAuto', label: 'Alerte pré-paie automatique', desc: 'Notification si une variable nécessite validation avant clôture' },
    { key: 'wellbeingWeekly', label: 'Rapport hebdomadaire bien-être', desc: 'Envoi automatique chaque lundi matin' },
    { key: 'turnoverAi', label: 'Prédictions IA turnover', desc: 'Alerte si risque de départ détecté dans une équipe' },
  ];

  const INTEGRATION_TOGGLES = [
    { key: 'silae', label: 'Silae (paie)', desc: 'Export variables pré-paie' },
    { key: 'yousign', label: 'Yousign (signatures)', desc: 'Documents RH — voir GUIDE_TRANSFERT.md' },
  ];

  let cachedSettings = null;
  let saving = false;

  function toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
  }

  function canEditCompanySettings() {
    const role = window.Auth?.user?.role;
    return role === 'DRH' || role === 'ADMIN';
  }

  function applyEditPermissions() {
    const editable = canEditCompanySettings();
    ['settings-company-name', 'settings-company-siret', 'settings-company-convention'].forEach(function (id) {
      const el = getInput(id);
      if (el) el.readOnly = !editable;
    });
    document.querySelectorAll('[data-settings-save]').forEach(function (btn) {
      btn.disabled = !editable;
      btn.title = editable ? '' : 'Réservé aux profils DRH / Admin';
    });
    document.querySelectorAll('[data-settings-tab="planning"] input:not([type="checkbox"])').forEach(function (el) {
      el.readOnly = !editable;
      el.disabled = !editable && (el.type === 'time' || el.type === 'number');
    });
    document.querySelectorAll('[data-settings-tab="planning"] input[type="checkbox"]').forEach(function (el) {
      el.disabled = !editable;
    });
  }

  function formatSiretDisplay(value) {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length !== 14) return value || '';
    return digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{5})$/, '$1 $2 $3 $4');
  }

  function getInput(id) {
    return document.getElementById(id);
  }

  function readPlanningSettings() {
    const rules = {};
    rules.openingHours = {
      start: getInput('settings-plan-open-start')?.value || '06:00',
      end: getInput('settings-plan-open-end')?.value || '23:00',
    };
    rules.operatingDays = DAY_LABELS
      .filter(function (d) {
        return document.getElementById('settings-plan-day-' + d.v)?.checked;
      })
      .map(function (d) { return d.v; });
    rules.shiftTemplates = {};
    SHIFT_TEMPLATE_KEYS.forEach(function (key) {
      rules.shiftTemplates[key] = {
        enabled: Boolean(document.getElementById('settings-shift-' + key + '-enabled')?.checked),
        start: getInput('settings-shift-' + key + '-start')?.value || null,
        end: getInput('settings-shift-' + key + '-end')?.value || null,
        label: getInput('settings-shift-' + key + '-label')?.value || key,
      };
    });
    rules.maxWeeklyHours = parseFloat(getInput('settings-plan-max-weekly')?.value) || 48;
    rules.legalWeeklyHours = parseFloat(getInput('settings-plan-legal-weekly')?.value) || 35;
    rules.maxDailyHours = parseFloat(getInput('settings-plan-max-daily')?.value) || 10;
    rules.minRestBetweenShifts = parseFloat(getInput('settings-plan-min-rest')?.value) || 11;
    return rules;
  }

  function applyPlanningSettingsToUI(data) {
    const rules = data?.settings?.planningRules || {};
    window._companyPlanningRules = rules;
    window.PLANNING_SHIFT_TEMPLATES = rules.shiftTemplates || {};
    window.PLAN_SHIFT_DEFAULT_TIMES = buildShiftTimesMap(rules.shiftTemplates);
    if (typeof window.refreshShiftTypeButtons === 'function') window.refreshShiftTypeButtons();

    const open = rules.openingHours || {};
    const openStart = getInput('settings-plan-open-start');
    const openEnd = getInput('settings-plan-open-end');
    if (openStart) openStart.value = open.start || '06:00';
    if (openEnd) openEnd.value = open.end || '23:00';

    const opDays = rules.operatingDays || [1, 2, 3, 4, 5, 6, 0];
    DAY_LABELS.forEach(function (d) {
      const el = document.getElementById('settings-plan-day-' + d.v);
      if (el) el.checked = opDays.indexOf(d.v) >= 0;
    });

    const templates = rules.shiftTemplates || {};
    SHIFT_TEMPLATE_KEYS.forEach(function (key) {
      const tpl = templates[key] || {};
      const en = document.getElementById('settings-shift-' + key + '-enabled');
      const st = getInput('settings-shift-' + key + '-start');
      const ed = getInput('settings-shift-' + key + '-end');
      const lb = getInput('settings-shift-' + key + '-label');
      if (en) en.checked = tpl.enabled !== false;
      if (st) st.value = tpl.start || '';
      if (ed) ed.value = tpl.end || '';
      if (lb) lb.value = tpl.label || key.charAt(0) + key.slice(1).toLowerCase();
    });

    const maxW = getInput('settings-plan-max-weekly');
    const legalW = getInput('settings-plan-legal-weekly');
    const maxD = getInput('settings-plan-max-daily');
    const minR = getInput('settings-plan-min-rest');
    if (maxW) maxW.value = rules.maxWeeklyHours != null ? rules.maxWeeklyHours : 48;
    if (legalW) legalW.value = rules.legalWeeklyHours != null ? rules.legalWeeklyHours : 35;
    if (maxD) maxD.value = rules.maxDailyHours != null ? rules.maxDailyHours : 10;
    if (minR) minR.value = rules.minRestBetweenShifts != null ? rules.minRestBetweenShifts : 11;
  }

  function buildShiftTimesMap(templates) {
    const out = {};
    const defaults = {
      MATIN: ['06:00', '14:00'],
      APREM: ['14:00', '22:00'],
      NUIT: ['22:00', '06:00'],
      JOURNEE: ['09:00', '18:00'],
    };
    SHIFT_TEMPLATE_KEYS.forEach(function (key) {
      const tpl = templates?.[key];
      if (tpl && tpl.enabled === false) return;
      if (tpl?.start && tpl?.end) out[key] = [tpl.start, tpl.end];
      else if (defaults[key]) out[key] = defaults[key];
    });
    return out;
  }

  window.refreshShiftTypeButtons = function refreshShiftTypeButtons() {
    const container = document.getElementById('shift-type-btns');
    if (!container) return;
    const templates = window.PLANNING_SHIFT_TEMPLATES || {};
    const times = window.PLAN_SHIFT_DEFAULT_TIMES || {};
    const defs = [
      { key: 'matin', type: 'MATIN', icon: '🌅', fallback: '6h – 14h' },
      { key: 'aprem', type: 'APREM', icon: '☀️', fallback: '14h – 22h' },
      { key: 'nuit', type: 'NUIT', icon: '🌙', fallback: '22h – 6h' },
    ];
    let html = '';
    defs.forEach(function (d) {
      const tpl = templates[d.type];
      if (tpl && tpl.enabled === false) return;
      const t = times[d.type];
      const label = tpl?.label || d.type.charAt(0) + d.type.slice(1).toLowerCase();
      const range = t ? formatShiftRange(t[0], t[1]) : d.fallback;
      html += '<button onclick="selectShiftType(this,\'' + d.key + '\')" data-shift-type="' + d.key + '" class="shift-type-btn" style="padding:10px 8px;border-radius:8px;border:2px solid var(--border);background:var(--bg);color:var(--text-2);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center">' +
        d.icon + ' ' + escapeHtml(label) + '<br><span style="font-weight:400;font-size:10.5px">' + escapeHtml(range) + '</span></button>';
    });
    html += '<button onclick="selectShiftType(this,\'off\')" data-shift-type="off" class="shift-type-btn" style="padding:10px 8px;border-radius:8px;border:2px solid var(--border);background:var(--bg);color:var(--text-2);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center">😴 Repos<br><span style="font-weight:400;font-size:10.5px">Jour libre</span></button>';
    html += '<button onclick="selectShiftType(this,\'absent\')" data-shift-type="absent" class="shift-type-btn" style="padding:10px 8px;border-radius:8px;border:2px solid var(--border);background:var(--bg);color:var(--text-2);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center">🤒 Absent<br><span style="font-weight:400;font-size:10.5px">Maladie / CP</span></button>';
    html += '<button onclick="selectShiftType(this,\'empty\')" data-shift-type="empty" class="shift-type-btn" style="padding:10px 8px;border-radius:8px;border:2px solid var(--border);background:var(--bg);color:var(--text-2);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;text-align:center">➕ Vide<br><span style="font-weight:400;font-size:10.5px">À planifier</span></button>';
    container.innerHTML = html;
    if (typeof selectShiftType === 'function' && window.currentShiftType) {
      selectShiftType(null, window.currentShiftType);
    }
  };

  function formatShiftRange(start, end) {
    if (!start || !end) return '';
    return start.replace(':00', 'h').replace(':', 'h') + ' – ' + end.replace(':00', 'h').replace(':', 'h');
  }

  function buildPlanningTabPanel() {
    const panel = document.createElement('div');
    panel.className = 'settings-tab-panel';
    panel.dataset.settingsTab = 'planning';
    panel.style.display = 'none';

    const shiftRows = SHIFT_TEMPLATE_KEYS.map(function (key) {
      const id = key.toLowerCase();
      return '<div class="toggle-row" style="flex-wrap:wrap;gap:8px;align-items:flex-end">' +
        '<div class="toggle-info" style="min-width:100px"><div class="toggle-name">' + key + '</div></div>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:12px"><input type="checkbox" id="settings-shift-' + key + '-enabled" checked> Actif</label>' +
        '<input class="form-input" id="settings-shift-' + key + '-label" placeholder="Libellé" style="width:110px;font-size:12px">' +
        '<input class="form-input" id="settings-shift-' + key + '-start" type="time" style="width:110px;font-size:12px">' +
        '<input class="form-input" id="settings-shift-' + key + '-end" type="time" style="width:110px;font-size:12px">' +
        '</div>';
    }).join('');

    const dayChecks = DAY_LABELS.map(function (d) {
      return '<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;margin-right:10px;cursor:pointer">' +
        '<input type="checkbox" id="settings-plan-day-' + d.v + '" checked> ' + d.label + '</label>';
    }).join('');

    panel.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Horaires d'ouverture</div>
        <p style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:14px">
          Définissez les plages horaires de votre établissement. Les sociétés qui ne fonctionnent pas 24h/24 peuvent désactiver les shifts de nuit ci-dessous.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Ouverture</label>
            <input class="form-input" id="settings-plan-open-start" type="time" value="06:00">
          </div>
          <div class="form-group">
            <label class="form-label">Fermeture</label>
            <input class="form-input" id="settings-plan-open-end" type="time" value="23:00">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Jours d'activité</label>
          <div style="margin-top:6px">${dayChecks}</div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Modèles de shifts</div>
        <p style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:14px">
          Horaires utilisés dans le planning manuel et l'IA. Désactivez le shift « Nuit » si votre établissement n'est pas ouvert la nuit.
        </p>
        ${shiftRows}
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Limites légales (Code du travail)</div>
        <p style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:14px">
          Ces valeurs servent au calcul automatique du maximum planifiable par collaborateur et aux alertes de conformité.
        </p>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Durée légale hebdo. (h)</label>
            <input class="form-input" id="settings-plan-legal-weekly" type="number" min="1" max="48" step="0.5" value="35">
          </div>
          <div class="form-group">
            <label class="form-label">Maximum hebdo. absolu (h)</label>
            <input class="form-input" id="settings-plan-max-weekly" type="number" min="35" max="60" step="0.5" value="48">
          </div>
          <div class="form-group">
            <label class="form-label">Maximum journalier (h)</label>
            <input class="form-input" id="settings-plan-max-daily" type="number" min="8" max="12" step="0.5" value="10">
          </div>
          <div class="form-group">
            <label class="form-label">Repos min. entre shifts (h)</label>
            <input class="form-input" id="settings-plan-min-rest" type="number" min="9" max="12" step="0.5" value="11">
          </div>
        </div>
      </div>`;
    panel.appendChild(buildActionBar('Sauvegarder le planning', 'savePlanningSettings(event)'));
    return panel;
  }

  async function savePlanningSettings(ev) {
    if (!canEditCompanySettings()) {
      toast('Seuls les profils DRH / Admin peuvent modifier ces paramètres');
      return;
    }
    const btn = ev?.target || document.querySelector('[data-settings-tab="planning"] [data-settings-save]');
    if (btn) { btn.disabled = true; btn.textContent = 'Sauvegarde…'; }
    try {
      await persistSettings({
        settings: { planningRules: readPlanningSettings() },
      }, 'Paramètres planning sauvegardés');
    } finally {
      if (btn) {
        btn.textContent = 'Sauvegarder le planning';
        btn.disabled = !canEditCompanySettings();
      }
    }
  }

  window.savePlanningSettings = savePlanningSettings;

  function readCompanyForm() {
    return {
      name: getInput('settings-company-name')?.value.trim() || '',
      siret: getInput('settings-company-siret')?.value.trim() || '',
      convention: getInput('settings-company-convention')?.value.trim() || '',
    };
  }

  function readNotificationSettings() {
    const notifications = {};
    NOTIF_TOGGLES.forEach(function (t) {
      const el = document.querySelector('[data-notif="' + t.key + '"]');
      notifications[t.key] = el ? el.classList.contains('on') : false;
    });
    return notifications;
  }

  function readIntegrationSettings() {
    const integrations = {};
    INTEGRATION_TOGGLES.forEach(function (t) {
      const el = document.querySelector('[data-integration="' + t.key + '"]');
      integrations[t.key] = el ? el.classList.contains('on') : false;
    });
    return integrations;
  }

  function applySettingsToUI(data) {
    if (!data) return;
    cachedSettings = data;

    const nameEl = getInput('settings-company-name');
    const siretEl = getInput('settings-company-siret');
    const convEl = getInput('settings-company-convention');
    const empEl = getInput('settings-company-employees');

    if (nameEl) nameEl.value = data.name || '';
    if (siretEl) siretEl.value = formatSiretDisplay(data.siret);
    if (convEl) convEl.value = data.convention || '';
    if (empEl) empEl.value = String(data.employeeCount ?? '');

    const settings = data.settings || {};
    NOTIF_TOGGLES.forEach(function (t) {
      const el = document.querySelector('[data-notif="' + t.key + '"]');
      if (!el) return;
      el.classList.toggle('on', Boolean(settings.notifications?.[t.key]));
    });
    INTEGRATION_TOGGLES.forEach(function (t) {
      const el = document.querySelector('[data-integration="' + t.key + '"]');
      if (!el) return;
      el.classList.toggle('on', Boolean(settings.integrations?.[t.key]));
    });
    applyPlanningSettingsToUI(data);
  }

  async function loadCompanySettings() {
    if (typeof api.companySettings !== 'function') return;
    try {
      const data = await api.companySettings();
      applySettingsToUI(data);
      applyEditPermissions();
    } catch (err) {
      toast(err.error || err.message || 'Impossible de charger les paramètres');
    }
  }

  async function persistSettings(partial, successMsg) {
    if (saving || typeof api.updateCompanySettings !== 'function') return;
    saving = true;
    try {
      const data = await api.updateCompanySettings(partial);
      applySettingsToUI(data);
      if (successMsg) toast(successMsg);
      return data;
    } catch (err) {
      toast(err.error || err.message || 'Erreur lors de la sauvegarde');
      if (cachedSettings) applySettingsToUI(cachedSettings);
      throw err;
    } finally {
      saving = false;
    }
  }

  window.saveSettings = async function saveSettings(ev) {
    if (!canEditCompanySettings()) {
      toast('Seuls les profils DRH / Admin peuvent modifier ces paramètres');
      return;
    }
    const btn = ev?.target || document.querySelector('[data-settings-save]');
    const form = readCompanyForm();
    if (!form.name) {
      toast('Le nom de l\'entreprise est obligatoire');
      return;
    }
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Sauvegarde…';
    }
    try {
      await persistSettings({
        name: form.name,
        siret: form.siret,
        convention: form.convention,
        settings: {
          notifications: readNotificationSettings(),
          integrations: readIntegrationSettings(),
        },
      }, 'Paramètres sauvegardés avec succès');
      if (btn) {
        btn.textContent = '✓ Sauvegardé';
        btn.style.background = 'var(--green)';
        setTimeout(function () {
          btn.textContent = 'Sauvegarder';
          btn.disabled = false;
          btn.style.background = '';
        }, 2000);
      }
    } catch {
      if (btn) {
        btn.textContent = 'Sauvegarder';
        btn.disabled = false;
      }
    }
  };

  window.cancelSettings = function cancelSettings() {
    if (cachedSettings) {
      applySettingsToUI(cachedSettings);
      toast('Modifications annulées');
      return;
    }
    loadCompanySettings();
  };

  async function saveNotificationToggle(key, el) {
    if (!canEditCompanySettings()) {
      el.classList.toggle('on');
      toast('Seuls les profils DRH / Admin peuvent modifier ces paramètres');
      return;
    }
    const enabled = el.classList.contains('on');
    try {
      await persistSettings({
        settings: { notifications: { [key]: enabled } },
      });
    } catch {
      el.classList.toggle('on', !enabled);
    }
  }

  async function saveIntegrationToggle(key, el) {
    if (!canEditCompanySettings()) {
      el.classList.toggle('on');
      toast('Seuls les profils DRH / Admin peuvent modifier ces paramètres');
      return;
    }
    const enabled = el.classList.contains('on');
    try {
      await persistSettings({
        settings: { integrations: { [key]: enabled } },
      });
    } catch {
      el.classList.toggle('on', !enabled);
    }
  }

  function wireToggle(el, saveFn, key) {
    if (!el || el.dataset.wired) return;
    el.dataset.wired = '1';
    el.addEventListener('click', function () {
      el.classList.toggle('on');
      saveFn(key, el);
    });
  }

  function wireNotificationToggles() {
    NOTIF_TOGGLES.forEach(function (t) {
      wireToggle(document.querySelector('[data-notif="' + t.key + '"]'), saveNotificationToggle, t.key);
    });
  }

  function wireIntegrationToggles() {
    INTEGRATION_TOGGLES.forEach(function (t) {
      wireToggle(document.querySelector('[data-integration="' + t.key + '"]'), saveIntegrationToggle, t.key);
    });
  }

  function buildActionBar(saveLabel, saveOnclick) {
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;margin-top:8px';
    const saveFn = saveOnclick || 'saveSettings(event)';
    bar.innerHTML =
      '<button type="button" class="btn btn-ghost" onclick="cancelSettings()">Annuler</button>' +
      '<button type="button" class="btn btn-primary" data-settings-save onclick="' + saveFn + '">' + (saveLabel || 'Sauvegarder') + '</button>';
    return bar;
  }

  function injectPushSection(container) {
    if (!container || document.getElementById('push-pwa-section')) return;

    const section = document.createElement('div');
    section.id = 'push-pwa-section';
    section.className = 'settings-section';
    section.innerHTML = `
      <div class="settings-section-title">Notifications push (navigateur)</div>
      <p style="font-size:13px;color:var(--text-2);margin-bottom:14px;line-height:1.5">
        Recevez les alertes planning, absences et pré-paie même lorsque Pulsiia n'est pas ouvert.
      </p>
      <div id="push-subscription-status" style="font-size:13px;color:var(--text-2);margin-bottom:12px">Non configuré</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" id="btn-push-enable">Activer les notifications</button>
        <button type="button" class="btn btn-ghost" id="btn-push-disable">Désactiver</button>
        <button type="button" class="btn btn-ghost" id="btn-push-test">Envoyer un test</button>
      </div>`;
    container.appendChild(section);

    document.getElementById('btn-push-enable')?.addEventListener('click', function () {
      window.pulsiiaPush?.subscribePush?.();
    });
    document.getElementById('btn-push-disable')?.addEventListener('click', function () {
      window.pulsiiaPush?.unsubscribePush?.();
    });
    document.getElementById('btn-push-test')?.addEventListener('click', function () {
      window.pulsiiaPush?.testPush?.();
    });

    refreshPushStatus();
  }

  async function refreshPushStatus() {
    const el = document.getElementById('push-subscription-status');
    if (!el || !('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        el.textContent = 'Notifications push activées ✓';
        el.style.color = 'var(--green)';
      } else {
        el.textContent = 'Notifications push désactivées';
        el.style.color = 'var(--text-2)';
      }
    } catch {
      el.textContent = 'Non configuré';
      el.style.color = 'var(--text-2)';
    }
  }

  async function loadSitesPanel() {
    const body = document.getElementById('settings-sites-body');
    if (!body) return;
    body.innerHTML = '<span style="color:var(--text-3)">Chargement…</span>';

    if (typeof api.userSites !== 'function') {
      body.innerHTML = '<span style="color:var(--red)">API indisponible</span>';
      return;
    }

    try {
      const res = await api.userSites();
      const sites = res.sites || [];
      if (!sites.length) {
        body.innerHTML = '<p style="font-size:13px;color:var(--text-2)">Aucun établissement enregistré.</p>';
        return;
      }
      body.innerHTML = sites.map(function (s) {
        const meta = [s.city, s.postalCode].filter(Boolean).join(' · ');
        return '<div class="toggle-row" style="cursor:default">' +
          '<div class="toggle-info"><div class="toggle-name">' + escapeHtml(s.name) + '</div>' +
          (meta ? '<div class="toggle-desc">' + escapeHtml(meta) + '</div>' : '') +
          '</div></div>';
      }).join('');
    } catch (err) {
      body.innerHTML = '<span style="color:var(--red)">' + escapeHtml(err.error || 'Erreur de chargement') + '</span>';
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initSettingsTabs() {
    const page = document.getElementById('page-settings');
    const panel = page?.querySelector('.settings-panel');
    if (!panel || panel.dataset.tabsInit) return;
    panel.dataset.tabsInit = '1';

    const sections = [...panel.querySelectorAll(':scope > .settings-section')];
    panel.querySelector(':scope > div[style*="justify-content:flex-end"]')?.remove();

    const entreprise = document.createElement('div');
    entreprise.className = 'settings-tab-panel';
    entreprise.dataset.settingsTab = 'entreprise';
    if (sections[0]) entreprise.appendChild(sections[0]);
    entreprise.appendChild(buildActionBar());

    const notifications = document.createElement('div');
    notifications.className = 'settings-tab-panel';
    notifications.dataset.settingsTab = 'notifications';
    notifications.style.display = 'none';
    if (sections[1]) {
      sections[1].querySelectorAll('.toggle.on, .toggle:not(.on)').forEach(function (toggle) {
        toggle.removeAttribute('onclick');
      });
      notifications.appendChild(sections[1]);
    }
    injectPushSection(notifications);
    notifications.appendChild(buildActionBar('Sauvegarder les alertes'));

    const etablissements = document.createElement('div');
    etablissements.className = 'settings-tab-panel';
    etablissements.dataset.settingsTab = 'etablissements';
    etablissements.style.display = 'none';
    etablissements.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Établissements</div>
        <p style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:14px">
          Liste des sites rattachés à votre entreprise. La gestion détaillée se fait via la page Collaborateurs.
        </p>
        <div id="settings-sites-body" style="margin-bottom:14px"></div>
        <button type="button" class="btn btn-ghost" onclick="showPage('collaborateurs')">→ Ouvrir Collaborateurs</button>
      </div>`;

    const integrations = document.createElement('div');
    integrations.className = 'settings-tab-panel';
    integrations.dataset.settingsTab = 'integrations';
    integrations.style.display = 'none';
    integrations.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Intégrations</div>
        ${INTEGRATION_TOGGLES.map(function (t) {
          return '<div class="toggle-row">' +
            '<div class="toggle-info"><div class="toggle-name">' + t.label + '</div><div class="toggle-desc">' + t.desc + '</div></div>' +
            '<div class="toggle" data-integration="' + t.key + '" role="switch" aria-checked="false" tabindex="0"></div>' +
            '</div>';
        }).join('')}
      </div>`;

    const securite = document.createElement('div');
    securite.className = 'settings-tab-panel';
    securite.dataset.settingsTab = 'securite';
    securite.style.display = 'none';
    securite.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Sécurité du compte</div>
        <div id="settings-2fa-body" style="font-size:13px;color:var(--text-2);margin-bottom:14px">Chargement…</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <button type="button" class="btn btn-ghost" style="justify-content:flex-start" onclick="changePassword()">🔑 Changer mon mot de passe</button>
          <button type="button" class="btn btn-ghost" id="settings-2fa-btn" style="justify-content:flex-start" onclick="toggle2FA()">🛡️ Activer la double authentification</button>
          <button type="button" class="btn btn-ghost" style="justify-content:flex-start;color:var(--text-3)" onclick="disconnectAllSessions()">↩ Déconnecter tous les appareils</button>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Données personnelles (RGPD)</div>
        <div id="settings-rgpd-body" style="font-size:13px;color:var(--text-2)">Chargement…</div>
      </div>`;

    panel.innerHTML = '';
    const planning = buildPlanningTabPanel();
    planning.dataset.settingsTab = 'planning';
    panel.append(entreprise, etablissements, planning, notifications, integrations, securite);

    const nav = page?.querySelector('.settings-nav');
    if (nav && !nav.querySelector('[data-settings-tab="planning"]')) {
      const planningNav = document.createElement('div');
      planningNav.className = 'settings-nav-item';
      planningNav.dataset.settingsTab = 'planning';
      planningNav.textContent = 'Planning & Shifts';
      planningNav.onclick = function () { window.switchSettingsTab(this); };
      const etabNav = nav.querySelector('[data-settings-tab="etablissements"]')
        || [...nav.querySelectorAll('.settings-nav-item')].find(function (n) {
          return n.textContent.trim() === 'Établissements';
        });
      if (etabNav?.nextSibling) nav.insertBefore(planningNav, etabNav.nextSibling);
      else nav.appendChild(planningNav);
    }

    NOTIF_TOGGLES.forEach(function (t, idx) {
      const rows = notifications.querySelectorAll('.toggle-row .toggle');
      if (rows[idx]) rows[idx].setAttribute('data-notif', t.key);
    });

    document.querySelectorAll('#page-settings .settings-nav-item').forEach(function (item, idx) {
      const label = item.textContent.trim();
      item.dataset.settingsTab = TAB_MAP[label] || ('tab-' + idx);
    });

    wireNotificationToggles();
    wireIntegrationToggles();
    applyEditPermissions();
  }

  function showSettingsTab(tabKey) {
    document.querySelectorAll('#page-settings .settings-tab-panel').forEach(function (p) {
      p.style.display = p.dataset.settingsTab === tabKey ? '' : 'none';
    });
    if (tabKey === 'securite') {
      if (typeof loadSettingsSecurity === 'function') loadSettingsSecurity();
      if (typeof loadRgpdPanel === 'function') loadRgpdPanel('settings-rgpd-body');
    }
    if (tabKey === 'etablissements') loadSitesPanel();
    if (tabKey === 'notifications') refreshPushStatus();
    if (tabKey === 'entreprise' || tabKey === 'notifications' || tabKey === 'integrations' || tabKey === 'planning') {
      loadCompanySettings();
    }
  }

  function patchSwitchSettingsTab() {
    if (window.switchSettingsTab && window.switchSettingsTab.__settingsApiPatched) return;
    window.switchSettingsTab = function (el) {
      document.querySelectorAll('.settings-nav-item').forEach(function (n) { n.classList.remove('active'); });
      el.classList.add('active');
      showSettingsTab(el.dataset.settingsTab || TAB_MAP[el.textContent.trim()] || 'entreprise');
    };
    window.switchSettingsTab.__settingsApiPatched = true;
  }

  function patchShowPageSettings() {
    if (typeof showPage !== 'function') {
      setTimeout(patchShowPageSettings, 30);
      return;
    }
    if (showPage.__settingsHookPatched) return;
    const original = showPage;
    window.showPage = function (name, navEl) {
      original(name, navEl);
      if (name === 'settings') {
        initSettingsTabs();
        const active = document.querySelector('#page-settings .settings-nav-item.active');
        showSettingsTab(active?.dataset.settingsTab || 'entreprise');
      }
    };
    window.showPage.__pagesApiPatched = original.__pagesApiPatched;
    window.showPage.__settingsHookPatched = true;
  }

  function deferInit() {
    initSettingsTabs();
    patchSwitchSettingsTab();
    patchShowPageSettings();
  }

  document.addEventListener('DOMContentLoaded', deferInit, { once: true });
  deferInit();
})();
