// 앱 파일은 네트워크 우선(새 버전이 바로 반영되게), 글꼴은 캐시 우선
// vendor/(얼굴 인식 모델·영상 먹서)는 버전이 경로에 들어 있어서 캐시 우선. 세워 두기를 처음 켤 때 받아 둔다
const CACHE = 'eopeodwo-v4';
const VENDOR_CACHE = 'eopeodwo-vendor-mp122-mux522';
const CORE = ['./', 'index.html', 'style.css', 'app.js', 'camera.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== VENDOR_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(VENDOR_CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  e.respondWith(fetch(req).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
    return res;
  }).catch(() => caches.match(req).then(hit => hit || caches.match('index.html'))));
});
