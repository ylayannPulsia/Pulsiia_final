// pwa.js — Service Worker + abonnement push Web Push (VAPID)
(function () {
  'use strict';

  const STATUS_ID = 'push-subscription-status';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function setStatus(text, ok) {
    const el = document.getElementById(STATUS_ID);
    if (!el) return;
    el.textContent = text;
    el.style.color = ok ? 'var(--green)' : ok === false ? '#DC2626' : 'var(--text-2)';
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register('/sw.js?v=5', { scope: '/' });
      if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      reg.update().catch(function () {});
      return reg;
    } catch (err) {
      console.warn('Service Worker:', err);
      return null;
    }
  }

  async function subscribePush() {
    if (!window.Auth?.isAuthenticated()) {
      setStatus('Connectez-vous pour activer les notifications.', false);
      return;
    }
    if (!('Notification' in window) || !('PushManager' in window)) {
      setStatus('Notifications non supportées par ce navigateur.', false);
      return;
    }

    setStatus('Activation en cours…', null);

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setStatus('Permission refusée — activez les notifications dans le navigateur.', false);
      return;
    }

    let publicKey;
    try {
      const res = await api.pushPublicKey();
      publicKey = res.publicKey;
    } catch (err) {
      setStatus(err.error || 'Clés VAPID manquantes côté serveur (.env).', false);
      return;
    }

    const reg = await registerServiceWorker();
    if (!reg) {
      setStatus('Impossible d\'enregistrer le Service Worker.', false);
      return;
    }

    await navigator.serviceWorker.ready;

    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    await api.pushSubscribe(subscription.toJSON());
    setStatus('Notifications push activées ✓', true);
    if (typeof showToast === 'function') showToast('Notifications push activées ✓');
  }

  async function unsubscribePush() {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await api.pushUnsubscribe(sub.endpoint).catch(function () {});
      await sub.unsubscribe();
    }
    setStatus('Notifications désactivées.', null);
    if (typeof showToast === 'function') showToast('Notifications push désactivées');
  }

  async function testPush() {
    try {
      const res = await api.pushTest();
      if (typeof showToast === 'function') showToast(res.message || 'Notification test envoyée');
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.error || 'Échec du test push');
    }
  }

  function injectPushControls() {
    if (document.getElementById('push-pwa-section')) return;
    const panel = document.querySelector('#page-settings .settings-tab-panel[data-settings-tab="notifications"]')
      || document.querySelector('#page-settings .settings-panel');
    if (!panel) return;

    const section = document.createElement('div');
    section.id = 'push-pwa-section';
    section.className = 'settings-section';
    section.innerHTML = `
      <div class="settings-section-title">Notifications push (navigateur)</div>
      <p style="font-size:13px;color:var(--text-2);margin-bottom:14px;line-height:1.5">
        Recevez les alertes planning, absences et pré-paie même lorsque Pulsiia n'est pas ouvert.
      </p>
      <div id="${STATUS_ID}" style="font-size:13px;color:var(--text-2);margin-bottom:12px">Non configuré</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn btn-primary" id="btn-push-enable">Activer les notifications</button>
        <button type="button" class="btn btn-ghost" id="btn-push-disable">Désactiver</button>
        <button type="button" class="btn btn-ghost" id="btn-push-test">Envoyer un test</button>
      </div>`;

    const notifPanel = document.querySelector('#page-settings .settings-tab-panel[data-settings-tab="notifications"]');
    const anchor = notifPanel || [...panel.querySelectorAll('.settings-section')].find(function (s) {
      return s.querySelector('.settings-section-title')?.textContent.includes('Notifications');
    });
    if (anchor) {
      anchor.appendChild(section);
    } else {
      panel.insertBefore(section, panel.firstChild);
    }

    document.getElementById('btn-push-enable')?.addEventListener('click', subscribePush);
    document.getElementById('btn-push-disable')?.addEventListener('click', unsubscribePush);
    document.getElementById('btn-push-test')?.addEventListener('click', testPush);
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (window.location.pathname.includes('dashboard') || document.getElementById('page-dashboard')) {
      registerServiceWorker();
      injectPushControls();
    }
  }, { once: true });

  window.pulsiiaPush = { subscribePush, unsubscribePush, testPush };
})();
