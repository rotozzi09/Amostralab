const CACHE_NAME = "labpiano-v3";
console.log("Service Worker v3 loading...");
const ASSETS = [
  "/",
  "/index.html",
  "/css/app.css",
  "/css/native.css",
  "/js/app.js",
  "/manifest.json"
];

self.addEventListener("install", (e) => {
  console.log("Service Worker: installing...");
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Service Worker: caching assets...");
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener("activate", (e) => {
  console.log("Service Worker: activating...");
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((k) => {
        if (k !== CACHE_NAME) {
          console.log("Service Worker: deleting old cache", k);
          return caches.delete(k);
        }
      })
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((res) => res || fetch(e.request))
  );
});
