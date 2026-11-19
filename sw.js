// ParkHere service worker
// เปลี่ยนเลขนี้ทุกครั้งที่ปล่อยงาน (script.js?v=39)
const CACHE_VERSION = 'parkhere-v35-signalword-script39';
const PRECACHE = ['offline.html', 'manifest.webmanifest', 'icons/192.png', 'icons/512.png', 'icons/180.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // ฟอนต์: cache แบบ stale-while-revalidate
  if (FONT_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(CACHE_VERSION).then((c) =>
        c.match(req).then((hit) => {
          const net = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  // ไม่แตะ ThingsBoard / CDN อื่นทั้งหมด และ sw.js เอง
  if (url.origin !== location.origin || url.pathname.endsWith('/sw.js')) return;

  // API ของ parkhere-api (/api/*) และ SSE: ไม่แคช ไม่แตะ (กันค้างข้อมูลการจอง/สถานะช่อง)
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/') ||
      (req.headers.get('accept') || '').includes('text/event-stream')) return;

  // หน้าเว็บ / CSS / JS / ไอคอน: เครือข่ายก่อน (กันไฟล์เก่าค้าง) แล้ว fallback เป็น cache
  e.respondWith(
    fetch(req)
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
        return r;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('offline.html') : Response.error()))
      )
  );
});
