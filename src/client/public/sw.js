// Minimal service worker: makes the site installable and keeps the app shell available offline.
// API calls, photos, auth and MCP always go to the network (private data is never cached here).
const CACHE = "atc-shell-v1";
const SHELL = ["/", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (/^\/(api|photos|mcp|\.well-known)\b/.test(url.pathname)) return;
  if (url.pathname.startsWith("/assets/")) {
    // Hashed, immutable build assets: cache first.
    e.respondWith(
      caches.match(e.request).then(
        (hit) => hit || fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        }),
      ),
    );
    return;
  }
  if (e.request.mode === "navigate") {
    // Network first for pages; fall back to the cached shell when offline.
    e.respondWith(fetch(e.request).catch(() => caches.match("/")));
  }
});
