const CACHE = 'sharpe-v14';
const STATIC = [
  '/sharpe/',
  '/sharpe/index.html',
  '/sharpe/app.html',
  '/sharpe/styles.css',
  '/sharpe/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only cache GET requests for same-origin assets; pass through Supabase API calls
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname.includes('supabase.co') || url.hostname.includes('googleapis.com')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok && url.origin === self.location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
      // Return cached version immediately, update in background (stale-while-revalidate)
      return cached || network;
    })
  );
});
