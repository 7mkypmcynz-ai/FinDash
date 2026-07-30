/**
 * Ledger's Worker. Static assets (the PWA itself) are served automatically
 * by Cloudflare for any request that matches a file in ./public - this
 * script only runs for /api/* (see wrangler.jsonc's run_worker_first),
 * relaying price data server-side since the browser can't call Stooq
 * directly (CORS). No secrets, no user data - just a public data proxy.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/prices") return handlePrices(url, ctx);
    if (url.pathname === "/api/gold") return handleGold(ctx);

    return env.ASSETS.fetch(request);
  },
};

async function handlePrices(url, ctx) {
  const raw = (url.searchParams.get("symbol") || "").trim().toLowerCase();
  const start = (url.searchParams.get("start") || "").replace(/-/g, "");
  const end = (url.searchParams.get("end") || new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  if (!raw) return json({ error: "symbol is required" }, 400);

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const ticker = raw.includes(".") ? raw : `${raw}.us`;
  const stooqUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker)}&i=d${start ? `&d1=${start}` : ""}&d2=${end}`;

  let text;
  try {
    const upstream = await fetch(stooqUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!upstream.ok) return json({ error: `upstream returned ${upstream.status}` }, 502);
    text = await upstream.text();
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e) }, 502);
  }

  if (!text || /^\s*</.test(text) || /no data/i.test(text)) {
    return json({ symbol: raw.toUpperCase(), points: [], error: "no data for this symbol" }, 404);
  }

  const points = parseStooqCsv(text);
  if (!points.length) {
    return json({ symbol: raw.toUpperCase(), points: [], error: "symbol returned no rows - check the ticker" }, 404);
  }

  const res = json({ symbol: raw.toUpperCase(), points });
  res.headers.set("Cache-Control", "public, max-age=21600");
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

async function handleGold(ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://ledger-internal.local/gold-spot");
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  let text;
  try {
    const upstream = await fetch("https://stooq.com/q/d/l/?s=xauusd&i=d", {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!upstream.ok) return json({ error: `upstream returned ${upstream.status}` }, 502);
    text = await upstream.text();
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e) }, 502);
  }

  const points = parseStooqCsv(text);
  if (!points.length) return json({ error: "no gold data returned" }, 502);
  const last = points[points.length - 1];

  const res = json({ price: last.close, date: last.date, source: "stooq" });
  res.headers.set("Cache-Control", "public, max-age=3600");
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function parseStooqCsv(text) {
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const delim = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].split(delim).map((h) => h.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const closeIdx = header.indexOf("close");
  if (dateIdx === -1 || closeIdx === -1) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delim);
    const date = cols[dateIdx];
    const close = parseFloat(cols[closeIdx]);
    if (date && isFinite(close)) out.push({ date, close });
  }
  return out;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
