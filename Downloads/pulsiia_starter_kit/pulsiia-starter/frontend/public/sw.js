/* Pulsiia — Service Worker (push + cache assets statiques uniquement) */
const CACHE = 'pulsiia-v10';
const PRECACHE = ['/config.defaults.js'];

/** Fichiers toujours rechargés depuis le réseau (HTML, JS applicatif, config). */
function isNetworkOnly(url) {
  if (url.pathname === '/dashboard' || url.pathname === '/' || url.pathname === '/maquette.html') return true;
  if (url.pathname === '/config.js') return true;
  if (url.pathname.startsWith('/js/') && url.pathname.endsWith('.js')) return true;
  if (url.pathname.endsWith('.html')) return true;
  return false;
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE).catch(function () {});
    }).then(function () { return self.skipWaiting(); }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }),
      );
    }).then(function () { return self.clients.claim(); }),
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  if (isNetworkOnly(url)) {
    event.respondWith(
      fetch(event.request).catch(function () {
        return caches.match(event.request);
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      return cached || fetch(event.request);
    }),
  );
});

self.addEventListener('push', function (event) {
  let data = { title: 'Pulsiia', body: 'Nouvelle notification', url: '/dashboard' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_e) { /* ignore */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: data.url || '/dashboard' },
    }),
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const target = event.notification.data?.url || '/dashboard';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (const client of list) {
        if ('focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    }),
  );
});
