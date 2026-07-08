const CACHE_NAME = "rad-diag-cache-20260708-2025v1";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./legacy-memos.js",
  "./questions.json",
  "./questions-data.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon-180.png",
  "./assets/questions/2025/q1.png",
  "./assets/questions/2025/q2.png",
  "./assets/questions/2025/q3.png",
  "./assets/questions/2025/q4.png",
  "./assets/questions/2025/q5.png",
  "./assets/questions/2025/q6.png",
  "./assets/questions/2025/q7.png",
  "./assets/questions/2025/q8.png",
  "./assets/questions/2025/q9.png",
  "./assets/questions/2025/q10.png",
  "./assets/questions/2025/q11.png",
  "./assets/questions/2025/q12.png",
  "./assets/questions/2025/q13.png",
  "./assets/questions/2025/q14.png",
  "./assets/questions/2025/q15.png",
  "./assets/questions/2025/q16.png",
  "./assets/questions/2025/q17.png",
  "./assets/questions/2025/q18.png",
  "./assets/questions/2025/q19.png",
  "./assets/questions/2025/q20.png",
  "./assets/questions/2025/q21.png",
  "./assets/questions/2025/q22.png",
  "./assets/questions/2025/q23.png",
  "./assets/questions/2025/q24.png",
  "./assets/questions/2025/q25.png",
  "./assets/questions/2025/q26.png",
  "./assets/questions/2025/q27.png",
  "./assets/questions/2025/q28.png",
  "./assets/questions/2025/q29.png",
  "./assets/questions/2025/q30.png",
  "./assets/questions/2025/q31.png",
  "./assets/questions/2025/q32.png",
  "./assets/questions/2025/q33.png",
  "./assets/questions/2025/q34.png",
  "./assets/questions/2025/q35.png",
  "./assets/questions/2025/q36.png",
  "./assets/questions/2025/q37.png",
  "./assets/questions/2025/q38.png",
  "./assets/questions/2025/q39.png",
  "./assets/questions/2025/q40.png",
  "./assets/questions/2025/q41.png",
  "./assets/questions/2025/q42.png",
  "./assets/questions/2025/q43.png",
  "./assets/questions/2025/q44.png",
  "./assets/questions/2025/q45.png",
  "./assets/questions/2025/q46.png",
  "./assets/questions/2025/q47.png",
  "./assets/questions/2025/q48.png",
  "./assets/questions/2025/q49.png",
  "./assets/questions/2025/q50.png",
  "./assets/questions/2025/q51.png",
  "./assets/questions/2025/q52.png",
  "./assets/questions/2025/q53.png",
  "./assets/questions/2025/q54.png",
  "./assets/questions/2025/q55.png",
  "./assets/questions/2025/q56.png",
  "./assets/questions/2025/q57.png",
  "./assets/questions/2025/q58.png",
  "./assets/questions/2025/q59.png",
  "./assets/questions/2025/q60.png",
  "./assets/questions/2025/q61.png",
  "./assets/questions/2025/q62.png",
  "./assets/questions/2025/q63.png",
  "./assets/questions/2025/q64.png",
  "./assets/questions/2025/q65.png",
  "./assets/questions/2025/q66.png",
  "./assets/questions/2025/q67.png",
  "./assets/questions/2025/q68.png",
  "./assets/questions/2025/q69.png",
  "./assets/questions/2025/q70.png",
  "./assets/questions/2025/q71.png",
  "./assets/questions/2025/q72.png",
  "./assets/questions/2025/q73.png",
  "./assets/questions/2025/q74.png",
  "./assets/questions/2025/q75.png",
  "./assets/questions/2025/q76.png",
  "./assets/questions/2025/q77.png",
  "./assets/questions/2025/q78.png",
  "./assets/questions/2025/q79.png",
  "./assets/questions/2025/q80.png",
  "./assets/questions/2025/q81.png",
  "./assets/questions/2025/q82.png",
  "./assets/questions/2025/q83.png",
  "./assets/questions/2025/q84.png",
  "./assets/questions/2025/q85.png",
  "./assets/questions/2025/q86.png",
  "./assets/questions/2025/q87.png",
  "./assets/questions/2025/q88.png",
  "./assets/questions/2025/q89.png",
  "./assets/questions/2025/q90.png",
  "./assets/questions/2025/q91.png",
  "./assets/questions/2025/q92.png",
  "./assets/questions/2025/q93.png",
  "./assets/questions/2025/q94.png",
  "./assets/questions/2025/q95.png",
  "./assets/questions/2025/q98.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;

  if (url.origin === self.location.origin) {
    // アプリのシェル（HTMLナビゲーションと中核JS/CSS）はネットワーク優先にして、
    // デプロイ直後に「新しいHTML＋古いapp.js」のような不整合が起きないようにする。
    const isShell =
      event.request.mode === "navigate" ||
      /\.(html|js|css)$/i.test(url.pathname);

    if (isShell) {
      event.respondWith(
        fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => caches.match(event.request))
      );
      return;
    }

    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
            }
            return response;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
    );
  }
});
