'use strict';

const CACHE_NAME = 'gama-music-shell-v29';
const SHELL_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './assets/icon.svg?v=29',
  './assets/icon-192.png?v=29',
  './assets/icon-512.png?v=29',
  './assets/apple-touch-icon.png?v=29',
  './assets/playlist/cat.svg',
  './assets/playlist/dog.svg',
  './assets/playlist/panda.svg',
  './assets/playlist/rabbit.svg',
  './assets/playlist/fox.svg',
  './assets/playlist/bear.svg',
  './assets/playlist/koala.svg',
  './assets/playlist/penguin.svg',
  './assets/playlist/red-panda.svg',
  './assets/playlist/frog.svg',
  './assets/playlist/tiger.svg',
  './assets/playlist/lion.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    return;
  }


  /*
   * MP3 不放进 Service Worker Cache。
   * 音频继续由 IndexedDB 管理。
   */
  if (
    url.pathname.startsWith('/media/') &&
    url.pathname.endsWith('.mp3')
  ) {
    return;
  }


  /*
   * media 里的 jpg/png/webp/avif
   * 也就是歌曲封面：
   * cache-first。
   */
  if (
    url.pathname.startsWith('/media/')
  ) {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => {

          if (cached) {
            return cached;
          }

          return fetch(event.request)
            .then((response) => {

              if (
                response.ok
              ) {
                const copy =
                  response.clone();

                caches.open(
                  CACHE_NAME
                ).then(
                  (cache) =>
                    cache.put(
                      event.request,
                      copy
                    )
                );
              }

              return response;
            });
        })
    );

    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});
