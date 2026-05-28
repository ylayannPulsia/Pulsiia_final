// notifications-api.js — Panneau cloche branché sur /api/notifications
(function () {
  'use strict';

  const REFRESH_INTERVAL_MS = 60000;
  let notifications = [];
  let notifPanelOpen = false;
  let refreshTimer = null;
  let loading = false;
  let outsideClickHandler = null;
  let panelClickHandler = null;

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function dotColor(type) {
    if (type === 'red') return 'var(--red)';
    if (type === 'orange') return 'var(--orange)';
    if (type === 'green') return 'var(--green)';
    return 'var(--blue)';
  }

  function unreadCount() {
    return notifications.filter((n) => !n.read).length;
  }

  function updateBadge(count) {
    const badge = document.getElementById('notif-count');
    const bell = document.getElementById('notif-bell-btn');
    if (badge) {
      badge.textContent = count > 0 ? String(count) : '';
      badge.classList.toggle('pulse', count > 0);
    }
    if (bell) {
      const tip = bell.querySelector('.tooltip');
      if (tip) {
        tip.textContent = count > 0
          ? count + ' nouvelle' + (count > 1 ? 's' : '') + ' alerte' + (count > 1 ? 's' : '')
          : 'Aucune nouvelle alerte';
      }
    }
  }

  function navigateToPage(pageName) {
    if (!pageName || typeof showPage !== 'function') return;
    const navEl = document.querySelector('.nav-item[onclick*="' + pageName + '"]');
    showPage(pageName, navEl || undefined);
  }

  function defaultViewAllPage() {
    const role = window.Auth?.user?.role;
    if (role === 'COLLABORATEUR') return 'accueil-collab';
    return 'flux';
  }

  function renderPanelContent() {
    if (!notifications.length) {
      return '<div style="padding:24px 16px;font-size:13px;color:var(--text-3);text-align:center">Aucune notification</div>';
    }

    return notifications.map((n) => {
      const bg = n.read ? 'white' : '#FAFBFF';
      const textStyle = n.read ? 'color:var(--text-2)' : '';
      const dotOpacity = n.read ? 'opacity:.3' : '';
      const unreadDot = !n.read
        ? '<div style="width:7px;height:7px;border-radius:50%;background:var(--blue);margin-left:auto;flex-shrink:0;margin-top:4px"></div>'
        : '';
      const keyAttr = escapeHtml(n.key);

      return (
        '<div class="notif-item" data-notif-key="' + keyAttr + '" data-action-page="' + escapeHtml(n.actionPage || '') + '" '
        + 'style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;cursor:pointer;background:' + bg + ';transition:background .12s">'
        + '<div style="width:8px;height:8px;border-radius:50%;background:' + dotColor(n.type) + ';flex-shrink:0;margin-top:4px;' + dotOpacity + '"></div>'
        + '<div style="flex:1;min-width:0">'
        + '<div style="font-size:13px;color:var(--text);line-height:1.4;' + textStyle + '">' + escapeHtml(n.text) + '</div>'
        + '<div style="font-size:11px;color:var(--text-3);margin-top:2px">' + escapeHtml(n.time) + '</div>'
        + '</div>'
        + unreadDot
        + '</div>'
      );
    }).join('');
  }

  function refreshPanelList() {
    const list = document.getElementById('notif-list');
    if (list) list.innerHTML = renderPanelContent();
  }

  function bindPanelEvents(panel) {
    if (!panel || panel.__notifBound) return;
    panel.__notifBound = true;

    panelClickHandler = (e) => {
      e.stopPropagation();

      if (e.target.closest('#notif-close')) {
        closeNotifPanel();
        return;
      }

      if (e.target.closest('#notif-mark-all')) {
        markAllNotifRead(true);
        return;
      }

      if (e.target.closest('#notif-view-all')) {
        closeNotifPanel();
        navigateToPage(defaultViewAllPage());
        return;
      }

      const item = e.target.closest('.notif-item');
      if (item) {
        readNotif(item.dataset.notifKey, item.dataset.actionPage);
      }
    };

    panel.addEventListener('click', panelClickHandler);

    panel.addEventListener('mouseover', (e) => {
      const item = e.target.closest('.notif-item');
      if (item) item.style.background = '#F8FAFC';
    });

    panel.addEventListener('mouseout', (e) => {
      const item = e.target.closest('.notif-item');
      if (!item) return;
      const n = notifications.find((x) => x.key === item.dataset.notifKey);
      item.style.background = n?.read ? 'white' : '#FAFBFF';
    });
  }

  function closeNotifPanel() {
    const panel = document.getElementById('notif-panel');
    if (panel) {
      if (panelClickHandler) {
        panel.removeEventListener('click', panelClickHandler);
        panelClickHandler = null;
      }
      panel.__notifBound = false;
      panel.remove();
    }
    if (outsideClickHandler) {
      document.removeEventListener('click', outsideClickHandler);
      outsideClickHandler = null;
    }
    notifPanelOpen = false;
  }

  function openNotifPanel() {
    closeNotifPanel();

    const panel = document.createElement('div');
    panel.id = 'notif-panel';
    panel.style.cssText = 'position:fixed;top:60px;right:16px;width:340px;background:white;border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-md);z-index:650;overflow:hidden;animation:fadeIn .2s ease';
    panel.innerHTML =
      '<div style="padding:14px 16px 10px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">'
      + '<div style="font-size:14px;font-weight:600">Notifications</div>'
      + '<div style="display:flex;gap:8px;align-items:center">'
      + '<button type="button" id="notif-mark-all" style="font-size:12px;color:var(--blue);cursor:pointer;background:none;border:none;padding:0;font-family:inherit">Tout lire</button>'
      + '<button type="button" id="notif-close" aria-label="Fermer" style="cursor:pointer;color:var(--text-3);font-size:18px;background:none;border:none;padding:0 2px;line-height:1;font-family:inherit">✕</button>'
      + '</div></div>'
      + '<div id="notif-list" style="max-height:360px;overflow-y:auto">' + renderPanelContent() + '</div>'
      + '<div style="padding:10px 16px;border-top:1px solid var(--border);text-align:center">'
      + '<button type="button" id="notif-view-all" style="font-size:12.5px;color:var(--blue);cursor:pointer;font-weight:500;background:none;border:none;padding:0;font-family:inherit">Voir toutes les notifications →</button>'
      + '</div>';

    document.body.appendChild(panel);
    bindPanelEvents(panel);

    outsideClickHandler = (e) => {
      if (!panel.contains(e.target) && !document.getElementById('notif-bell-btn')?.contains(e.target)) {
        closeNotifPanel();
      }
    };
    setTimeout(() => document.addEventListener('click', outsideClickHandler), 0);
    notifPanelOpen = true;
  }

  async function loadNotifications(silent) {
    if (!window.Auth?.isAuthenticated() || typeof api?.notifications !== 'function') return;
    if (loading) return;

    loading = true;
    try {
      const data = await api.notifications();
      notifications = data.notifications || [];
      updateBadge(data.unreadCount ?? unreadCount());

      if (document.getElementById('notif-panel')) {
        refreshPanelList();
      }
    } catch (err) {
      if (!silent && typeof showToast === 'function') {
        showToast(err.error || err.message || 'Impossible de charger les notifications');
      }
    } finally {
      loading = false;
    }
  }

  async function toggleNotifPanel() {
    if (notifPanelOpen) {
      closeNotifPanel();
      return;
    }
    await loadNotifications(true);
    openNotifPanel();
  }

  async function readNotif(key, actionPage) {
    const n = notifications.find((x) => x.key === key);
    if (n) n.read = true;
    updateBadge(unreadCount());
    closeNotifPanel();

    if (typeof api?.markNotificationRead === 'function') {
      api.markNotificationRead(key).catch(() => {});
    }

    if (actionPage) navigateToPage(actionPage);
    else if (typeof showToast === 'function') showToast('Notification lue ✓');
  }

  async function markAllNotifRead(keepOpen) {
    notifications.forEach((n) => { n.read = true; });
    updateBadge(0);
    refreshPanelList();

    if (!keepOpen) closeNotifPanel();

    try {
      if (typeof api?.markAllNotificationsRead === 'function') {
        await api.markAllNotificationsRead();
      }
      if (typeof showToast === 'function') showToast('Toutes les notifications marquées comme lues ✓');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Erreur');
      loadNotifications(true);
    }
  }

  function setupAutoRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (!document.hidden && window.Auth?.isAuthenticated()) {
        loadNotifications(true);
      }
    }, REFRESH_INTERVAL_MS);
  }

  function patchApplySession() {
    if (typeof applyAuthenticatedSession !== 'function' || applyAuthenticatedSession.__notifPatched) return;
    const orig = applyAuthenticatedSession;
    window.applyAuthenticatedSession = function (user) {
      orig(user);
      loadNotifications(true);
    };
    applyAuthenticatedSession.__notifPatched = true;
  }

  function patchDashboardRefresh() {
    if (typeof loadDashboard !== 'function' || loadDashboard.__notifPatched) return;
    const orig = loadDashboard;
    window.loadDashboard = async function () {
      await orig();
      loadNotifications(true);
    };
    loadDashboard.__notifPatched = true;
  }

  function deferInit() {
    if (typeof api === 'undefined') {
      setTimeout(deferInit, 40);
      return;
    }
    patchApplySession();
    patchDashboardRefresh();
    setupAutoRefresh();

    if (window.Auth?.isAuthenticated()) {
      loadNotifications(true);
    }
  }

  window.toggleNotifPanel = toggleNotifPanel;
  window.readNotif = readNotif;
  window.markAllNotifRead = markAllNotifRead;
  window.loadNotifications = loadNotifications;
  window.closeNotifPanel = closeNotifPanel;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', deferInit);
  } else {
    deferInit();
  }
})();
