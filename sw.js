/* Groovelog Service Worker
   Caches the app shell for offline/fast loading
   API calls always go to network (fresh data)
*/
const CACHE = 'groovelog-v1';
const SHELL = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  
  // Always fetch API calls fresh from network — never cache
  if (url.hostname.includes('railway.app') ||
      url.hostname.includes('musicbrainz') ||
      url.hostname.includes('coverartarchive') ||
      url.hostname.includes('wikipedia')) {
    e.respondWith(fetch(e.request).catch(() => new Response('offline', {status: 503})));
    return;
  }

  // App shell — serve from cache, fall back to network
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
