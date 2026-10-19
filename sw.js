// Drape service worker: makes the app installable and usable offline.
// Bump CACHE whenever index.html changes so phones pick up the new version.
const CACHE = "drape-v0.9.4";
const IMG_CACHE = "drape-img-v1"; // AI photos: kept across app versions
const IMG_MAX = 300;
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);

  // Fonts: cache-first, they never change.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
          if (res && (res.ok || res.type === "opaque")) c.put(e.request, res.clone());
          return res;
        }))
      )
    );
    return;
  }

  // AI photos from the Drape worker: the same idea always gets the same photo,
  // so keep each one on the phone and never draw it twice.
  if (url.origin !== self.location.origin && url.pathname === "/image" && url.searchParams.has("p")) {
    e.respondWith(
      caches.open(IMG_CACHE).then((c) =>
        c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
          if (res && res.ok) {
            c.put(e.request, res.clone()).then(() => trim(c));
          }
          return res;
        }))
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App files: network-first so a new deploy shows up right away; cache only when offline.
  // cache: "no-store" because iOS home-screen apps can otherwise serve a stale copy.
  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});

async function trim(c) {
  const keys = await c.keys();
  for (let i = 0; i < keys.length - IMG_MAX; i++) await c.delete(keys[i]);
}
