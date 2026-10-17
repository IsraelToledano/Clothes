// Drape AI server (Cloudflare Worker).
//
// The app on the phone calls this worker; the worker holds the API keys.
//   GET  /health  → which services are set up (also checks the access code)
//   POST /ideas   → Claude writes new style ideas from the request and the votes so far
//   GET  /image   → an AI photo for one idea (Cloudflare Workers AI, FLUX.1 schnell)
//   POST /shop    → real products from Google Shopping (Serper), ranked by Claude
//
// Set up in the Cloudflare dashboard (Worker → Settings → Variables and Secrets):
//   ACCESS_CODE        secret: any passcode; type the same one into the app once
//   ANTHROPIC_API_KEY  secret: from console.anthropic.com
//   SERPER_API_KEY     secret: from serper.dev (2,500 free searches)
// The image model needs no key: it runs on the Workers AI binding in wrangler.toml.

const APP_ORIGIN = "https://israeltoledano.github.io";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const SERPER_URL = "https://google.serper.dev/shopping";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

const TYPES = ["T-shirts", "Shirts", "Overshirts", "Knitwear", "Jackets", "Trousers", "Shorts", "Shoes"];
const STYLES = ["Relaxed", "Minimal", "Smart-casual", "Streetwear", "Vintage", "Sporty"];

const cors = (origin) => ({
  "Access-Control-Allow-Origin": origin === APP_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "") ? origin : APP_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});
const json = (obj, status, origin) =>
  new Response(JSON.stringify(obj), { status: status || 200, headers: { "Content-Type": "application/json", ...cors(origin) } });

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    try {
      if (url.pathname === "/") return json({ ok: true, service: "drape-ai" }, 200, origin);

      if (req.method === "GET" && url.pathname === "/health") {
        checkCode(env, url.searchParams.get("code"));
        return json({ ok: true, claude: !!env.ANTHROPIC_API_KEY, images: !!env.AI, shopping: !!env.SERPER_API_KEY }, 200, origin);
      }

      if (req.method === "GET" && url.pathname === "/image") {
        checkCode(env, url.searchParams.get("code"));
        return await image(env, url.searchParams.get("p"), url.searchParams.get("s"), origin);
      }

      if (req.method === "POST" && (url.pathname === "/ideas" || url.pathname === "/shop")) {
        let body;
        try { body = JSON.parse(await req.text()); } catch (e) { throw new HttpError(400, "Request isn't valid JSON"); }
        checkCode(env, body && body.code);
        const out = url.pathname === "/ideas" ? await ideas(env, body) : await shop(env, body);
        return json(out, 200, origin);
      }

      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: String((e && e.message) || e) }, status, origin);
    }
  },
};

function checkCode(env, code) {
  if (!env.ACCESS_CODE) throw new HttpError(503, "Set ACCESS_CODE in the worker's settings first");
  if (!code || String(code).trim() !== String(env.ACCESS_CODE).trim()) throw new HttpError(401, "Wrong access code");
}

/* ---------------- Claude ---------------- */

async function claude(env, { model, system, user, schema, maxTokens, thinking }) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "ANTHROPIC_API_KEY isn't set in the worker");
  const base = {
    model,
    max_tokens: maxTokens || 4000,
    system,
    messages: [{ role: "user", content: user }],
  };
  const tuned = { ...base, thinking, output_config: { effort: "low", format: { type: "json_schema", schema } } };
  let res = await callAnthropic(env, tuned);
  // If this model rejects the speed settings, retry with only the schema.
  if (res.status === 400) {
    const err = await res.clone().text();
    if (/thinking|effort/i.test(err)) res = await callAnthropic(env, { ...base, output_config: { format: { type: "json_schema", schema } } });
  }
  if (!res.ok) {
    const err = await res.text();
    throw new HttpError(502, "Claude API error " + res.status + ": " + err.slice(0, 300));
  }
  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === "text");
  if (!block) throw new HttpError(502, "Claude returned no text" + (data.stop_reason ? " (" + data.stop_reason + ")" : ""));
  try { return JSON.parse(block.text); }
  catch (e) { throw new HttpError(502, "Claude's reply wasn't valid JSON" + (data.stop_reason === "max_tokens" ? " (too long)" : "")); }
}

function callAnthropic(env, payload) {
  return fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload),
  });
}

/* ---------------- /ideas ---------------- */

const IDEA_SCHEMA = {
  type: "object",
  properties: {
    insight: { type: "string" },
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: TYPES },
          title: { type: "string" },
          desc: { type: "string" },
          fit: { type: "string" },
          fabric: { type: "string" },
          colour: { type: "string" },
          vibe: { type: "string" },
          styles: { type: "array", items: { type: "string", enum: STYLES } },
          palette: { type: "array", items: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } },
          why: { type: "string" },
          search: { type: "string" },
          image_prompt: { type: "string" },
        },
        required: ["type", "title", "desc", "fit", "fabric", "colour", "vibe", "styles", "palette", "why", "search", "image_prompt"],
        additionalProperties: false,
      },
    },
  },
  required: ["insight", "ideas"],
  additionalProperties: false,
};

const IDEAS_SYSTEM = `You are the stylist inside Drape, a personal menswear discovery app used by one man who lives in Tel Aviv, Israel. He says what he's looking for, you propose clothing ideas, he votes on each one (Hate / Like / Love), and you use those votes to get closer to what he'll love.

An idea is a concept, not a product: a specific kind of garment defined by cut, fabric, colour and mood (for example "Linen camp-collar shirt" in terracotta) that many stores sell in some version. Never name brands.

How to use his votes:
- Loved: stay close. Vary one or two things (colour, fabric, a detail) to find the best version of it.
- Liked: keep what worked and try a fresher take.
- Hated: avoid that combination. If he hated two or three in a row, change direction clearly.
- Long-term taste from earlier sessions is a starting point; today's request and today's votes count more.
- Make about one idea in five a deliberate step outside the pattern so you keep learning. Its "why" is "Something different".
- Never repeat or closely copy anything in "Already shown".
- Use exactly the requested type unless it is "Surprise me". Follow his styles and his own words, including anything he says he doesn't want.
- Think about Tel Aviv weather in the given month (long hot humid summers, short mild winters).

Field rules:
- title: up to 32 characters, sentence case. desc: one sentence, up to 80 characters, about how it looks and wears.
- fit, fabric, colour, vibe: one or two words each, Title case. Reuse the same words for the same things across ideas (always "Linen", always "Relaxed").
- styles: one to three from the allowed list.
- palette: three hex colours: the garment's main colour, a secondary colour in it, then a colour it pairs well with.
- why: "Because you loved: <exact title>" or "Because you liked: <exact title>" when it builds on one of today's votes; "Something different" for an exploration; otherwise "".
- search: a 3–6 word English shopping query that starts with "men's", e.g. "men's terracotta linen camp collar shirt".
- image_prompt: up to 300 characters for an image model: a photorealistic catalogue photo of exactly this garment (colour, fabric texture, key details) worn by a man. Tops and jackets: framed from neck to mid-thigh, face out of frame. Trousers and shorts: waist to feet. Shoes: close-up on feet, side view. Plain light studio backdrop.
- insight: when today has 3 or more votes, up to 70 characters on what you've learned, written to follow the words "Adjusting to you:", e.g. "more earthy linen and relaxed fits, less shiny sporty fabrics". Otherwise "".`;

async function ideas(env, b) {
  const count = Math.max(1, Math.min(8, parseInt(b.count, 10) || 5));
  const q = b.query || {};
  const lines = [];
  lines.push("Month: " + (b.month || new Date().toLocaleString("en", { month: "long" })));
  lines.push("Looking for: " + (q.type || "Surprise me"));
  if (Array.isArray(q.styles) && q.styles.length) lines.push("Styles: " + q.styles.join(", "));
  if (q.text) lines.push("In his words: " + String(q.text).slice(0, 500));
  if (b.anchor) lines.push("He picked this idea but didn't find the right product. Give close variations of it: " + describe(b.anchor));
  if (b.redirect) lines.push("He has hated several ideas in a row: change direction clearly.");

  const round = Array.isArray(b.votes) ? b.votes.slice(-25) : [];
  lines.push("", "Today's votes, oldest first:" + (round.length ? "" : " none yet"));
  for (const v of round) lines.push("- " + (v.vote || "").toUpperCase() + ": " + describe(v));

  const t = b.taste || {};
  if ((t.more && t.more.length) || (t.less && t.less.length) || (t.loved && t.loved.length) || (t.hated && t.hated.length)) {
    lines.push("", "Long-term taste from earlier sessions:");
    if (t.more && t.more.length) lines.push("More of: " + t.more.join(", "));
    if (t.less && t.less.length) lines.push("Less of: " + t.less.join(", "));
    if (t.loved && t.loved.length) lines.push("Loved before: " + t.loved.join("; "));
    if (t.hated && t.hated.length) lines.push("Hated before: " + t.hated.join("; "));
    if (t.picked && t.picked.length) lines.push("Picked to buy before: " + t.picked.join("; "));
  }
  if (Array.isArray(b.seen) && b.seen.length) lines.push("", "Already shown (don't repeat): " + b.seen.slice(-80).join("; "));
  lines.push("", `Write ${count} new ideas, best bet first.`);

  const out = await claude(env, {
    model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
    system: IDEAS_SYSTEM,
    user: lines.join("\n"),
    schema: IDEA_SCHEMA,
    maxTokens: 6000,
    thinking: { type: "between_tools" },
  });

  const list = (out.ideas || []).slice(0, count).map((i) => ({
    id: "ai-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    type: TYPES.includes(i.type) ? i.type : (q.type && TYPES.includes(q.type) ? q.type : "Shirts"),
    title: clip(i.title, 48),
    desc: clip(i.desc, 140),
    fit: clip(i.fit, 24), fabric: clip(i.fabric, 24), colour: clip(i.colour, 24), vibe: clip(i.vibe, 24),
    styles: (i.styles || []).filter((s) => STYLES.includes(s)).slice(0, 3),
    palette: fixPalette(i.palette),
    why: clip(i.why, 70),
    search: clip(i.search, 80),
    image_prompt: clip(i.image_prompt, 420),
  }));
  return { ideas: list, insight: clip(out.insight, 90) };
}

function describe(i) {
  return [i.title, i.colour, i.fabric, i.fit && i.fit + " fit", i.vibe, i.type].filter(Boolean).map((x) => clip(x, 60)).join(", ");
}
const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n);
function fixPalette(p) {
  const ok = (Array.isArray(p) ? p : []).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 3);
  while (ok.length < 3) ok.push(["#C9CDD5", "#E3E6EB", "#16181D"][ok.length]);
  return ok;
}

/* ---------------- /image ---------------- */

const IMAGE_STYLE = "Photorealistic menswear e-commerce photo, soft even studio light, sharp fabric detail, natural colours, no text, no logos, no watermark.";

async function image(env, prompt, seed, origin) {
  if (!env.AI) throw new HttpError(503, "The Workers AI binding isn't set up");
  prompt = clip(prompt, 600);
  if (!prompt) throw new HttpError(400, "Missing prompt");
  const s = Math.abs(parseInt(seed, 10) || 0) % 2147483647;
  const out = await env.AI.run(IMAGE_MODEL, { prompt: prompt + " " + IMAGE_STYLE, steps: 6, seed: s });
  const b64 = out && out.image;
  if (!b64) throw new HttpError(502, "The image model returned nothing");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable", ...cors(origin) },
  });
}

/* ---------------- /shop ---------------- */

// Rough rates for the budget filter only; prices show in the store's own currency.
const TO_ILS = { "₪": 1, "ILS": 1, "$": 3.7, "USD": 3.7, "€": 4.0, "EUR": 4.0, "£": 4.7, "GBP": 4.7 };
const BUDGET = { "u200": [0, 200], "200-400": [200, 400], "400+": [400, Infinity] };

function priceILS(str) {
  const s = String(str || "");
  const n = parseFloat(s.replace(/[^\d.,]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", "."));
  if (!isFinite(n)) return null;
  const cur = Object.keys(TO_ILS).find((k) => s.includes(k));
  return cur ? Math.round(n * TO_ILS[cur]) : null;
}

const SHOP_SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: { i: { type: "integer" }, why: { type: "string" } },
        required: ["i", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["picks"],
  additionalProperties: false,
};

async function shop(env, b) {
  if (!env.SERPER_API_KEY) throw new HttpError(503, "SERPER_API_KEY isn't set in the worker");
  const idea = b.idea || {};
  let q = clip(idea.search || ["men's", idea.colour, idea.fabric, idea.title].filter(Boolean).join(" "), 100);
  if (!/\bmen'?s?\b/i.test(q)) q = "men's " + q;

  const res = await fetch(SERPER_URL, {
    method: "POST",
    headers: { "X-API-KEY": env.SERPER_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q, gl: "il", hl: "en", num: 40 }),
  });
  if (!res.ok) throw new HttpError(502, "Shopping search error " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  let items = (data.shopping || [])
    .filter((p) => p && p.title && p.link)
    .map((p) => ({
      title: clip(p.title, 140),
      store: clip(p.source, 60),
      price: clip(p.price, 30),
      ils: priceILS(p.price),
      image: p.imageUrl || "",
      link: p.link,
      rating: p.rating || null,
      delivery: clip(p.delivery, 60),
    }));
  const total = items.length;

  // Budget: keep items in range (and unknown prices); if nothing is left, show everything.
  let budgetRelaxed = false;
  const range = BUDGET[b.budget];
  if (range) {
    const inRange = items.filter((p) => p.ils == null || (p.ils >= range[0] && p.ils <= range[1]));
    if (inRange.length) items = inRange; else budgetRelaxed = items.length > 0;
  }

  // Claude (fast model) keeps the menswear items that match the idea, best first.
  let ranked = false;
  if (items.length > 3 && env.ANTHROPIC_API_KEY) {
    try {
      const listing = items.slice(0, 30).map((p, i) => `${i}. ${p.title} | ${p.store} | ${p.price}`).join("\n");
      const out = await claude(env, {
        model: env.SHOP_MODEL || "claude-haiku-5-5",
        system: "You help a man in Israel shop for one clothing idea. From a numbered list of search results, choose the products that are menswear and genuinely match the idea (type, colour, fabric, cut). Best match first, at most 10. For each give a 'why' of up to 40 characters saying what matches or differs (e.g. 'Right colour, slightly slimmer cut'). Skip women's and kids' items, accessories, and anything that isn't this kind of garment.",
        user: "Idea: " + describe(idea) + (idea.desc ? ". " + idea.desc : "") + "\n\nResults:\n" + listing,
        schema: SHOP_SCHEMA,
        maxTokens: 1500,
        thinking: { type: "disabled" },
      });
      const seen = new Set();
      const picked = (out.picks || [])
        .filter((p) => Number.isInteger(p.i) && p.i >= 0 && p.i < Math.min(30, items.length) && !seen.has(p.i) && seen.add(p.i))
        .map((p) => ({ ...items[p.i], why: clip(p.why, 60) }));
      if (picked.length) { items = picked; ranked = true; }
    } catch (e) { /* show unranked results instead */ }
  }

  return { query: q, products: items.slice(0, 12), total, ranked, budgetRelaxed };
}
