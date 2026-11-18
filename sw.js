/* Yohoho x ブロスタ — Service Worker
   ゲームのファイルをブラウザにキャッシュして、オフラインでも開けるようにする。
   新しい版を出したときは CACHE_NAME の数字（v1 → v2…）を上げると、古いキャッシュが消えて新しい版に置き換わる。 */
const CACHE_NAME = 'yohoho-v4';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/base.css',
  './css/lobby.css',
  './css/rooms.css',
  './css/gacha.css',
  './css/game.css',
  './css/net.css',
  './js/sound.js',
  './js/data.js',
  './js/lobby.js',
  './js/gacha.js',
  './js/game.js',
  './js/input.js',
  './js/net.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* まずキャッシュ、なければネット。ネットから取れたらキャッシュにも入れる。
   リダイレクトやエラーのレスポンスはキャッシュしない（壊れたキャッシュが残ると
   インストール済みアプリが ERR_FAILED で開けなくなるため）。
   ネットもキャッシュもダメなら、ナビゲーションは index.html を返す。 */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response && response.ok && response.type !== 'opaque') {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('オフラインです', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      });
    })
  );
});
