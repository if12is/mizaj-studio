/* Mizaj Word add-in service worker (best effort, see the guide).
   Network first; the answers are kept so that the add-in pages and Office.js can still load when
   Mizaj is closed or the machine is offline, in which case the page itself says «افتح برنامج مِزَاج أولاً».
   The API (/wa/*) is never cached or intercepted, and no document text ever passes through here. */
const CACHE = 'mizaj-addin-v1'
const OFFICE_CDN = 'appsforoffice.microsoft.com'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const u = new URL(req.url)
  if (u.pathname.startsWith('/wa/')) return
  if (u.origin !== self.location.origin && u.hostname !== OFFICE_CDN) return
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined)
        }
        return res
      })
      .catch(() => caches.match(req).then((hit) => hit || Response.error()))
  )
})
