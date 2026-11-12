/* Cofrade Granada · service worker: caché sin conexión + notificaciones push */
const V = "cofrade-v3";
const PUSH = new URL(self.location).searchParams.get("p") || "";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) =>
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
    await self.clients.claim();
  })())
);

// Red primero y, si no hay conexión, lo último guardado (solo archivos de la propia app)
self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(r);
      if (res.ok) (await caches.open(V)).put(r, res.clone());
      return res;
    } catch (err) {
      return (await caches.match(r, { ignoreSearch: true })) || (await caches.match("./")) || Response.error();
    }
  })());
});

// Push sin carga: se pide al servidor qué avisos hay pendientes y se muestran
self.addEventListener("push", (e) =>
  e.waitUntil((async () => {
    let items = [];
    try {
      const s = await self.registration.pushManager.getSubscription();
      if (s && PUSH) {
        const r = await fetch(PUSH.replace(/\/$/, "") + "/pending", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: s.endpoint }),
        });
        if (r.ok) items = await r.json();
      }
    } catch (err) {}
    if (!items.length) items = [{ title: "Cofrade Granada", body: "Tienes novedades en la app.", url: "#", tag: "cg-novedades" }];
    await Promise.all(items.map((i) =>
      self.registration.showNotification(i.title, {
        body: i.body, icon: "icon-192.png", badge: "icon-192.png", tag: i.tag || "cg", data: { url: i.url || "#" },
      })
    ));
  })())
);

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const h = (e.notification.data || {}).url || "#";
  e.waitUntil((async () => {
    const cs = await clients.matchAll({ type: "window", includeUncontrolled: true });
    if (cs.length) { await cs[0].focus(); cs[0].postMessage({ hash: h }); return; }
    await clients.openWindow(self.registration.scope + h);
  })());
});
