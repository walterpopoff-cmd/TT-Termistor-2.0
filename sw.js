const CACHE_NAME = 'termistores-v2.0';
const ASSETS_TO_CACHE = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    // Estrategia Offline-First: Cache first, network fallback
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request).catch(() => {
                // Fallback para cuando no hay red y no está en caché
                return new Response('Sin conexión y recurso no disponible en caché');
            });
        })
    );
});
