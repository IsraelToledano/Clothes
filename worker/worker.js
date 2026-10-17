// Drape AI server (Cloudflare Worker). 100% free: everything runs on Workers AI,
// Cloudflare's built-in AI, inside its free daily allowance. No API keys.
//
//   GET  /health  → checks the access code and that the AI binding is there
//   POST /ideas   → an LLM writes new style ideas from the request and the votes so far
//   GET  /image   → an AI photo for one idea (FLUX.1 schnell)
//
// One setting in the Cloudflare dashboard (Worker → Settings → Variables and Secrets):
//   ACCESS_CODE  secret: any passcode; type the same one into the app once.
//
// The free allowance is 10,000 "neurons" a day (resets 00:00 UTC = 03:00 in Israel).
// On the free plan Cloudflare blocks requests past that instead of charging.

const APP_ORIGIN = "https://israeltoledano.github.io";
const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
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
        return json({ ok: true, ideas: !!env.AI, images: !!env.AI }, 200, origin);
      }

      if (req.method === "GET" && url.pathname === "/image") {
        checkCode(env, url.searchParams.get("code"));
        return await image(env, url.searchParams.get("p"), url.searchParams.get("s"), origin);
      }

      if (req.method === "POST" && url.pathname === "/ideas") {
        let body;
        try { body = JSON.parse(await req.text()); } catch (e) { throw new HttpError(400, "Request isn't valid JSON"); }
        checkCode(env, body && body.code);
        return json(await ideas(env, body), 200, origin);
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

// Workers AI errors: turn "used up the daily free allocation" into a clear message.
async function runAI(env, model, input) {
  if (!env.AI) throw new HttpError(503, "The Workers AI binding isn't set up");
  try {
    return await env.AI.run(model, input);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/4006|daily free allocation|neurons|quota|rate limit|429/i.test(msg)) {
      throw new HttpError(429, "Today's free AI allowance is used up. It resets at 03:00.");
    }
    throw new HttpError(502, "AI error: " + msg.slice(0, 200));
  }
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
          type: { type: "string" },
          title: { type: "string" },
          desc: { type: "string" },
          fit: { type: "string" },
          fabric: { type: "string" },
          colour: { type: "string" },
          vibe: { type: "string" },
          styles: { type: "array", items: { type: "string" } },
          palette: { type: "array", items: { type: "string" } },
          why: { type: "string" },
          search: { type: "string" },
          image_prompt: { type: "string" },
        },
        required: ["type", "title", "desc", "fit", "fabric", "colour", "vibe", "styles", "palette", "why", "search", "image_prompt"],
      },
    },
  },
  required: ["insight", "ideas"],
};

const EXAMPLE = {
  type: "Shirts", title: "Linen camp-collar shirt", desc: "Open collar, short sleeves, straight hem worn untucked.",
  fit: "Relaxed", fabric: "Linen", colour: "Terracotta", vibe: "Summer", styles: ["Relaxed", "Vintage"],
  palette: ["#B8643E", "#E8CDB9", "#F4EFE6"], why: "",
  search: "men's terracotta linen camp collar shirt",
  image_prompt: "Terracotta linen short-sleeve camp-collar shirt with visible slub texture, worn open over a white tee by a man, framed neck to mid-thigh, face out of frame, plain light studio backdrop",
};

const IDEAS_SYSTEM = `You are the stylist inside Drape, a personal menswear app for one man who lives in Tel Aviv, Israel. He says what he's looking for, you propose clothing ideas, he votes on each (Hate / Like / Love), and you use the votes to get closer to what he'll love.

Think like a menswear editor at GQ or Vogue: current, editorial and genuinely wearable, with the details that make a piece look considered (cut, proportion, fabric, colour pairing). When he names brands or references, capture their spirit in the ideas.

An idea is a concept, not a product: a specific kind of garment defined by cut, fabric, colour and mood that many stores sell in some version. Never name brands.

Using his votes:
- Loved: stay close. Vary one or two things (colour, fabric, a detail) to find the best version.
- Liked: keep what worked and try a fresher take.
- Hated: avoid that combination. If he hated several in a row, change direction clearly.
- Long-term taste is a starting point; today's request and today's votes count more.
- Make about one idea in five a deliberate step outside the pattern so you keep learning. Its "why" is "Something different".
- Never repeat or closely copy anything in "Already shown".
- Use exactly the requested type unless it is "Surprise me". Follow his styles and his own words, including what he says he doesn't want.
- Think about Tel Aviv weather in the given month (long hot humid summers, short mild winters).

Reply with JSON only: {"insight": "...", "ideas": [ ... ]}. Each idea has exactly these fields:
- type: one of ${TYPES.join(", ")}
- title: up to 32 characters, sentence case
- desc: one sentence, up to 80 characters, about how it looks and wears
- fit, fabric, colour, vibe: one or two words each, Title case; reuse the same words for the same things
- styles: one to three of ${STYLES.join(", ")}
- palette: three hex colours: main colour, secondary, a colour it pairs with
- why: "Because you loved: <exact title>" or "Because you liked: <exact title>" when it builds on one of today's votes; "Something different" for an exploration; otherwise ""
- search: 3 to 6 English words for a shopping search, starting with "men's"
- image_prompt: up to 250 characters describing a photorealistic catalogue photo of exactly this garment (colour, fabric texture, key details) worn by a man. Tops and jackets: framed neck to mid-thigh, face out of frame. Trousers and shorts: waist to feet. Shoes: close-up on feet, side view. Plain light studio backdrop.
insight: if today has 3 or more votes, up to 70 characters on what you've learned, written to follow "Adjusting to you:", e.g. "more earthy linen and relaxed fits, less shiny sporty fabrics". Otherwise "".

Example idea: ${JSON.stringify(EXAMPLE)}`;

async function ideas(env, b) {
  const count = Math.max(1, Math.min(6, parseInt(b.count, 10) || 4));
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
  for (const v of round) lines.push("- " + String(v.vote || "").toUpperCase() + ": " + describe(v));

  const t = b.taste || {};
  if ((t.more && t.more.length) || (t.less && t.less.length) || (t.loved && t.loved.length) || (t.hated && t.hated.length)) {
    lines.push("", "Long-term taste from earlier sessions:");
    if (t.more && t.more.length) lines.push("More of: " + t.more.join(", "));
    if (t.less && t.less.length) lines.push("Less of: " + t.less.join(", "));
    if (t.loved && t.loved.length) lines.push("Loved before: " + t.loved.join("; "));
    if (t.hated && t.hated.length) lines.push("Hated before: " + t.hated.join("; "));
    if (t.picked && t.picked.length) lines.push("Picked to buy before: " + t.picked.join("; "));
  }
  if (Array.isArray(b.seen) && b.seen.length) lines.push("", "Already shown (don't repeat): " + b.seen.slice(-60).join("; "));
  lines.push("", `Write ${count} new ideas, best bet first. JSON only.`);

  const messages = [{ role: "system", content: IDEAS_SYSTEM }, { role: "user", content: lines.join("\n") }];
  const model = env.TEXT_MODEL || TEXT_MODEL;
  let out;
  try {
    out = parseJSON((await runAI(env, model, { messages, max_tokens: 2400, temperature: 0.8, response_format: { type: "json_schema", json_schema: IDEA_SCHEMA } })).response);
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw e;
    out = null;
  }
  // JSON mode can fail ("couldn't be met"); ask once more as plain text and pull the JSON out.
  if (!out || !Array.isArray(out.ideas)) {
    out = parseJSON((await runAI(env, model, { messages, max_tokens: 2400, temperature: 0.7 })).response);
  }
  if (!out || !Array.isArray(out.ideas)) throw new HttpError(502, "The AI's reply wasn't usable. Try again.");

  const list = out.ideas.slice(0, count).filter((i) => i && i.title).map((i) => ({
    id: "ai-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    type: pickFrom(TYPES, i.type) || pickFrom(TYPES, q.type) || "Shirts",
    title: clip(i.title, 48),
    desc: clip(i.desc, 140),
    fit: clip(i.fit, 24), fabric: clip(i.fabric, 24), colour: clip(i.colour, 24), vibe: clip(i.vibe, 24),
    styles: (Array.isArray(i.styles) ? i.styles : []).map((s) => pickFrom(STYLES, s)).filter(Boolean).slice(0, 3),
    palette: fixPalette(i.palette),
    why: clip(i.why, 70),
    search: clip(i.search, 80) || ("men's " + clip(i.colour, 24) + " " + clip(i.title, 48)).toLowerCase(),
    image_prompt: clip(i.image_prompt || [i.colour, i.fabric, i.title, "worn by a man"].join(" "), 420),
  }));
  return { ideas: list, insight: clip(out.insight, 90) };
}

function parseJSON(r) {
  if (r && typeof r === "object") return r;
  const s = String(r || "");
  try { return JSON.parse(s); } catch (e) {}
  const a = s.indexOf("{"), z = s.lastIndexOf("}");
  if (a >= 0 && z > a) { try { return JSON.parse(s.slice(a, z + 1)); } catch (e) {} }
  return null;
}
function pickFrom(list, v) {
  const k = String(v || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  return list.find((x) => x.toLowerCase() === k || x.toLowerCase().replace(/-/g, "") === k.replace(/-/g, "") || x.toLowerCase() === k + "s") || null;
}
function describe(i) {
  return [i.title, i.colour, i.fabric, i.fit && i.fit + " fit", i.vibe, i.type].filter(Boolean).map((x) => clip(x, 60)).join(", ");
}
const clip = (s, n) => String(s == null ? "" : s).trim().slice(0, n);
function fixPalette(p) {
  const ok = (Array.isArray(p) ? p : []).map((c) => String(c).trim()).map((c) => (/^[0-9a-f]{6}$/i.test(c) ? "#" + c : c)).filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 3);
  while (ok.length < 3) ok.push(["#C9CDD5", "#E3E6EB", "#16181D"][ok.length]);
  return ok;
}

/* ---------------- /image ---------------- */

const IMAGE_STYLE = "Photorealistic menswear e-commerce photo, soft even studio light, sharp fabric detail, natural colours, no text, no logos, no watermark.";

async function image(env, prompt, seed, origin) {
  prompt = clip(prompt, 600);
  if (!prompt) throw new HttpError(400, "Missing prompt");
  const s = Math.abs(parseInt(seed, 10) || 0) % 2147483647;
  const out = await runAI(env, IMAGE_MODEL, { prompt: prompt + " " + IMAGE_STYLE, steps: 4, seed: s });
  const headers = { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable", ...cors(origin) };
  // Models have returned a base64 string, raw bytes or a stream; accept all of them.
  if (out instanceof ReadableStream) return new Response(out, { headers });
  if (out instanceof ArrayBuffer || ArrayBuffer.isView(out)) return new Response(out, { headers });
  let b64 = out && (out.image || out.result || (typeof out === "string" ? out : ""));
  if (b64 && typeof b64 === "object" && b64.image) b64 = b64.image;
  if (typeof b64 !== "string" || !b64) throw new HttpError(502, "The image model returned nothing usable (" + Object.keys(out || {}).join(",") + ")");
  b64 = b64.replace(/^data:image\/\w+;base64,/, "");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers });
}
