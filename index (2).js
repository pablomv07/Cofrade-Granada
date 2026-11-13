/* Cofrade Granada · servidor de notificaciones push (Cloudflare Worker)
   - POST /sub      guarda la suscripción, favoritas y preferencias
   - POST /unsub    la borra
   - POST /pending  (lo llama el service worker) devuelve y vacía los avisos pendientes
   - POST /test     envía un aviso de prueba
   - cron (cada hora): tiempo (9h), salidas próximas (10h) y pregunta del día (10h), hora de Madrid */

const RAMOS = [2027, 2, 21]; // 21 de marzo de 2027
const DIAS = ["Domingo de Ramos", "Lunes Santo", "Martes Santo", "Miércoles Santo", "Jueves Santo", "Viernes Santo", "Sábado Santo", "Domingo de Resurrección"];
const H_TIEMPO = 9, H_RESTO = 10, H_MAX = 21;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "content-type": "application/json" } });

const enc = (s) => new TextEncoder().encode(s);
function b64u(buf) {
  const b = typeof buf === "string" ? enc(buf) : new Uint8Array(buf);
  let s = "";
  b.forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function keyOf(endpoint) {
  const h = await crypto.subtle.digest("SHA-256", enc(endpoint));
  return "s:" + [...new Uint8Array(h)].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
}

/* ---------- Fechas (Europe/Madrid) ---------- */
function madrid(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(now).map((x) => [x.type, x.value])
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}
const dayNum = (iso) => Math.round(Date.UTC(...iso.split("-").map((x, i) => (i === 1 ? +x - 1 : +x))) / 864e5);
const salidaDate = (dia) => new Date(Date.UTC(RAMOS[0], RAMOS[1], RAMOS[2] + dia)).toISOString().slice(0, 10);

/* ---------- VAPID + envío (push sin carga; el service worker pide el contenido) ---------- */
async function vapidHeader(env, endpoint) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT }));
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(header + "." + payload));
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}
async function ping(env, endpoint) {
  return fetch(endpoint, {
    method: "POST",
    headers: { Authorization: await vapidHeader(env, endpoint), TTL: "43200", Urgency: "normal", "Content-Length": "0" },
  });
}

/* ---------- Contenido de los avisos ---------- */
const WE = (c) => (c === 0 ? "☀️" : c <= 2 ? "🌤️" : c === 3 ? "☁️" : c <= 48 ? "🌫️" : c <= 57 ? "🌦️" : c <= 67 ? "🌧️" : c <= 77 ? "🌨️" : c <= 82 ? "🌧️" : c <= 86 ? "🌨️" : "⛈️");

async function tiempoMsg(cache) {
  if (cache.w === undefined) {
    try {
      const r = await fetch("https://api.open-meteo.com/v1/forecast?latitude=37.1773&longitude=-3.5986&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Europe%2FMadrid&forecast_days=2");
      const j = await r.json();
      const d = j.daily;
      const f = (i) => ({ c: d.weather_code[i], max: Math.round(d.temperature_2m_max[i]), min: Math.round(d.temperature_2m_min[i]), r: d.precipitation_probability_max[i] || 0 });
      cache.w = { hoy: f(0), man: f(1) };
    } catch (e) {
      cache.w = null;
    }
  }
  const w = cache.w;
  if (!w) return null;
  const a = w.hoy, b = w.man;
  let body = `${WE(a.c)} Hoy ${a.max}°/${a.min}° · lluvia ${a.r}%. Mañana ${WE(b.c)} ${b.max}°/${b.min}° · ${b.r}%.`;
  if (Math.max(a.r, b.r) >= 50) body += " ☔ Revisa las redes de tu hermandad si hay procesión.";
  return { title: "Tiempo en Granada", body, url: "#", tag: "tiempo" };
}

function proximasMsg(rec, hoy) {
  const lineas = [];
  for (const f of rec.favs || []) {
    if (typeof f.dia !== "number" || f.dia < 0 || f.dia > 7) continue;
    const d = dayNum(salidaDate(f.dia)) - dayNum(hoy);
    const k = `u:${f.id}:${d}`;
    if (![7, 1, 0].includes(d) || rec.sent[k]) continue;
    rec.sent[k] = 1;
    const cuando = d === 7 ? "dentro de una semana" : d === 1 ? "mañana" : "hoy";
    lineas.push(`${f.n}: ${cuando}${f.s ? " a las " + f.s : ""} (${DIAS[f.dia]})`);
  }
  if (!lineas.length) return null;
  return { title: lineas.length === 1 ? "⭐ Tu favorita sale pronto" : `⭐ ${lineas.length} favoritas salen pronto`, body: lineas.join("\n"), url: "#", tag: "proximas" };
}

const triviaMsg = () => ({ title: "🎯 Pregunta del día cofrade", body: "Tu pregunta de hoy te espera. ¡No pierdas la racha!", url: "#trivial", tag: "trivial" });

/* ---------- Cron ---------- */
async function run(env) {
  const { date, hour } = madrid();
  if (hour > H_MAX) return;
  const cache = {};
  let cursor;
  do {
    const l = await env.SUBS.list({ prefix: "s:", cursor });
    cursor = l.list_complete ? undefined : l.cursor;
    for (const k of l.keys) {
      const rec = await env.SUBS.get(k.name, "json");
      if (!rec || !rec.sub) continue;
      rec.sent = rec.sent || {};
      rec.pend = rec.pend || [];
      const p = rec.p || {};
      let add = 0;
      if (p.w !== 0 && hour >= H_TIEMPO && rec.sent.w !== date) {
        const m = await tiempoMsg(cache);
        if (m) { rec.pend.push(m); add++; }
        rec.sent.w = date;
      }
      if (p.u !== 0 && hour >= H_RESTO) {
        const m = proximasMsg(rec, date);
        if (m) { rec.pend.push(m); add++; }
      }
      if (p.t !== 0 && hour >= H_RESTO && rec.sent.t !== date) {
        rec.pend.push(triviaMsg()); add++;
        rec.sent.t = date;
      }
      // limpiar claves antiguas
      const ks = Object.keys(rec.sent);
      if (ks.length > 80) ks.slice(0, ks.length - 80).forEach((x) => delete rec.sent[x]);
      rec.pend = rec.pend.slice(-6);
      if (add) {
        const gone = await enviar(env, rec);
        if (gone) { await env.SUBS.delete(k.name); continue; }
      }
      await env.SUBS.put(k.name, JSON.stringify(rec));
    }
  } while (cursor);
}

async function enviar(env, rec) {
  try {
    const r = await ping(env, rec.sub.endpoint);
    return r.status === 404 || r.status === 410;
  } catch (e) {
    return false;
  }
}

/* ---------- HTTP ---------- */
export default {
  async scheduled(_ev, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "POST") return json({ ok: true, app: "cofrade-push" });
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    let b;
    try { b = await req.json(); } catch (e) { return json({ error: "json" }, 400); }

    if (path === "/sub") {
      const sub = b.sub;
      if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 600) return json({ error: "sub" }, 400);
      const key = await keyOf(sub.endpoint);
      const old = (await env.SUBS.get(key, "json")) || {};
      const favs = (Array.isArray(b.favs) ? b.favs : []).slice(0, 60).map((f) => ({
        id: +f.id || 0, n: String(f.n || "").slice(0, 80), dia: Number.isInteger(f.dia) ? f.dia : -1, s: /^\d{1,2}:\d{2}$/.test(f.s || "") ? f.s : "",
      }));
      const p = { w: b.p && b.p.w === 0 ? 0 : 1, u: b.p && b.p.u === 0 ? 0 : 1, t: b.p && b.p.t === 0 ? 0 : 1 };
      await env.SUBS.put(key, JSON.stringify({ sub: { endpoint: sub.endpoint }, favs, p, sent: old.sent || {}, pend: old.pend || [] }));
      return json({ ok: true });
    }
    if (typeof b.endpoint !== "string") return json({ error: "endpoint" }, 400);
    const key = await keyOf(b.endpoint);
    if (path === "/unsub") { await env.SUBS.delete(key); return json({ ok: true }); }
    const rec = await env.SUBS.get(key, "json");
    if (!rec) return json({ error: "unknown" }, 404);
    if (path === "/pending") {
      const out = rec.pend || [];
      if (out.length) { rec.pend = []; await env.SUBS.put(key, JSON.stringify(rec)); }
      return json(out);
    }
    if (path === "/test") {
      rec.pend = [...(rec.pend || []), { title: "🧪 Prueba · Cofrade Granada", body: "Las notificaciones funcionan, incluso con la app cerrada.", url: "#", tag: "prueba" }].slice(-6);
      await env.SUBS.put(key, JSON.stringify(rec));
      const gone = await enviar(env, rec);
      if (gone) { await env.SUBS.delete(key); return json({ error: "gone" }, 410); }
      return json({ ok: true });
    }
    return json({ error: "ruta" }, 404);
  },
};

export { run, madrid, proximasMsg, tiempoMsg, vapidHeader };
