// Drape AI server (Cloudflare Worker). 100% free: everything runs on Workers AI,
// Cloudflare's built-in AI, inside its free daily allowance. No API keys.
//
//   GET  /health  → checks the access code and that the AI binding is there
//   POST /products → real products from real stores for one kind of garment (no AI, free)
//   POST /more    → Gemma writes 2-3 searches from a heart (or the brief), then searches the stores
//   POST /ideas   → an LLM writes new style ideas from the request and the swipes so far (Gemma 4, Llama 3.3 as backup)
//   GET  /diag    → a tiny test call to each AI model, with Cloudflare's exact answer (for the Drape report)
//   GET  /image   → an AI product photo for one idea (FLUX.1 schnell, FLUX.2 klein 4B as backup)
//
// One setting in the Cloudflare dashboard (Worker → Settings → Variables and Secrets):
//   ACCESS_CODE  secret: any passcode; type the same one into the app once.
//
// The free allowance is 10,000 "neurons" a day (resets 00:00 UTC = 03:00 in Israel).
// On the free plan Cloudflare blocks requests past that instead of charging.

// Bump with the app version so a report shows whether the server was redeployed.
const SERVER_VERSION = "1.0.0";
const APP_ORIGIN = "https://israeltoledano.github.io";
// Gemma 4 26B (4B active) is fast and costs about a sixth of Llama 3.3 70B per idea in the free allowance.
const TEXT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
const TEXT_BACKUP = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
let textTrouble = { until: 0, error: "" };
// Measured live (Oct 2026), same quality with the product-shot prompt:
//   schnell: 1-2s, but about 150 neurons a photo (1024px, billed per tile and step)
//   klein:   9-14s, about 50 neurons a photo at 512x768 (billed per output tile)
// So the first cards of a search use schnell (the app asks with q=fast), everything after uses klein,
// drawn ahead of time while you look at the current card. Each falls back to the other.
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const IMAGE_BACKUP = "@cf/black-forest-labs/flux-2-klein-4b";
const IMG_W = 512, IMG_H = 768; // portrait like the card; two 512px tiles, about the cost of one schnell photo
// If the main image model fails (not the daily limit), use the backup for a while and say why in /health.
let imageTrouble = { until: 0, error: "" };

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
  // One log line per request (path, status, time, where from; never the access code), visible in
  // Cloudflare → Workers → clothes → Observability, to see what uses the free daily allowance.
  async fetch(req, env) {
    const t0 = Date.now();
    const res = await handle(req, env);
    const u = new URL(req.url);
    if (u.pathname !== "/" && req.method !== "OPTIONS") {
      console.log(JSON.stringify({
        path: u.pathname, status: res.status, ms: Date.now() - t0,
        model: res.headers.get("X-Drape-Image-Model") || undefined,
        from: req.headers.get("Origin") || "-", country: (req.cf && req.cf.country) || "-",
        ua: String(req.headers.get("User-Agent") || "").slice(0, 80),
        who: /^ey[\w-]+\.[\w-]+\./.test(u.searchParams.get("code") || "") ? "github-test" : "app",
      }));
    }
    return res;
  },
};

async function handle(req, env) {
  {
    const origin = req.headers.get("Origin");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    try {
      if (url.pathname === "/") return json({ ok: true, service: "drape-ai", version: SERVER_VERSION }, 200, origin);

      if (req.method === "GET" && url.pathname === "/health") {
        await checkCode(env, url.searchParams.get("code"));
        return json({ ok: true, ideas: !!env.AI, images: !!env.AI, version: SERVER_VERSION, textModel: textModelNow(), imageModel: imageModelNow() }, 200, origin);
      }

      if (req.method === "GET" && url.pathname === "/diag") {
        await checkCode(env, url.searchParams.get("code"));
        return json(await diag(env), 200, origin);
      }

      if (req.method === "GET" && url.pathname === "/image") {
        await checkCode(env, url.searchParams.get("code"));
        // Thumbnails only ever show photos the phone already has; never draw a new one for them.
        if (url.searchParams.get("thumb")) return json({ error: "not drawn yet" }, 404, origin);
        return await image(env, url.searchParams.get("p"), url.searchParams.get("t"), origin, url.searchParams.get("q") === "fast");
      }

      if (req.method === "POST" && (url.pathname === "/products" || url.pathname === "/more")) {
        let body;
        try { body = JSON.parse(await req.text()); } catch (e) { throw new HttpError(400, "Request isn't valid JSON"); }
        await checkCode(env, body && body.code);
        return json(url.pathname === "/products" ? await products(env, body) : await more(env, body), 200, origin);
      }

      if (req.method === "POST" && url.pathname === "/ideas") {
        let body;
        try { body = JSON.parse(await req.text()); } catch (e) { throw new HttpError(400, "Request isn't valid JSON"); }
        await checkCode(env, body && body.code);
        return json(await ideas(env, body), 200, origin);
      }

      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      return json({ error: String((e && e.message) || e) }, status, origin);
    }
  }
}

async function checkCode(env, code) {
  if (!env.ACCESS_CODE) throw new HttpError(503, "Set ACCESS_CODE in the worker's settings first");
  if (code && String(code).trim() === String(env.ACCESS_CODE).trim()) return;
  // The repo's live test (GitHub Actions) signs in with a short-lived GitHub token for this repo,
  // so the test needs no stored secret.
  if (code && String(code).split(".").length === 3 && await githubTestToken(code)) return;
  throw new HttpError(401, "Wrong access code");
}

const GH_ISSUER = "https://token.actions.githubusercontent.com";
const GH_REPO = "israeltoledano/clothes";
let jwks = null;
const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
async function githubTestToken(tok) {
  try {
    const [h, p, sig] = String(tok).split(".");
    const head = JSON.parse(new TextDecoder().decode(b64url(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64url(p)));
    if (claims.iss !== GH_ISSUER || claims.aud !== "drape-live-test" || String(claims.repository || "").toLowerCase() !== GH_REPO) return false;
    if (!(claims.exp * 1000 > Date.now()) || head.alg !== "RS256") return false;
    if (!jwks || Date.now() - jwks.at > 3600 * 1000 || !jwks.keys.some((k) => k.kid === head.kid)) {
      const r = await fetch(GH_ISSUER + "/.well-known/jwks");
      jwks = { at: Date.now(), keys: (await r.json()).keys || [] };
    }
    const k = jwks.keys.find((x) => x.kid === head.kid);
    if (!k) return false;
    const key = await crypto.subtle.importKey("jwk", { kty: k.kty, n: k.n, e: k.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(sig), new TextEncoder().encode(h + "." + p));
  } catch (e) { return false; }
}

// A model call that hangs must not hang the app: give up after a while and use the backup.
function timeLimit(promise, ms, what) {
  let t;
  return Promise.race([promise, new Promise((_, no) => { t = setTimeout(() => no(new HttpError(503, what + " took longer than " + Math.round(ms / 1000) + "s")), ms); })]).finally(() => clearTimeout(t));
}

// Workers AI errors: turn "used up the daily free allocation" into a clear message.
async function runAI(env, model, input) {
  if (!env.AI) throw new HttpError(503, "The Workers AI binding isn't set up");
  try {
    return await env.AI.run(model, input);
  } catch (e) {
    const msg = String((e && e.message) || e).replace(/\s+/g, " ").trim();
    const said = " (Cloudflare: " + msg.slice(0, 160) + ")";
    // Only the daily free allocation is "used up". Busy / rate-limited is temporary, and the caller
    // tries the backup model instead.
    if (/\b(4006|3036)\b|daily free allocation|used up your daily|daily allocation/i.test(msg)) {
      throw new HttpError(429, "Today's free AI allowance is used up. It resets at 00:00 UTC (03:00 in Israel in summer time)." + said);
    }
    if (/\b(3040|3007|429)\b|capacity|rate.?limit|too many requests|overloaded|timed? ?out/i.test(msg)) {
      throw new HttpError(503, "The AI is busy right now. Try again in a minute." + said);
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
  type: "Shirts", title: "Washed oxford button-down", desc: "Soft broken-in oxford cloth, button-down collar, slightly relaxed body.",
  fit: "Relaxed", fabric: "Oxford cotton", colour: "University Blue", vibe: "Preppy", styles: ["Smart-casual", "Minimal"],
  palette: ["#9DB7D9", "#F4F1EA", "#1F2A44"], why: "J.Crew-style washed oxford",
  search: "men's washed oxford button down shirt",
  image_prompt: "University-blue washed oxford cloth shirt, button-down collar, chest pocket, long sleeves, slightly relaxed body, soft faded basketweave texture",
};

const IDEAS_SYSTEM = `You are the stylist inside Drape, a personal menswear app for one man who lives in Tel Aviv, Israel. Each time he is hunting for one specific piece. He gives a brief, you propose clothing ideas, and he swipes on each: HEART (getting closer to what he wants) or X (not this one right now: a gentle signal about that piece, never a ban on its style or colour). Your job is to converge on the piece he is imagining.

His brief comes first. Read his own words carefully and make every idea clearly answer them. When he names brands, every idea must look like something those brands actually sell, in their signature aesthetic. When there is no vote-based reason, say in "why" which reference an idea follows (e.g. "Ralph Lauren-style madras"). Brand names may appear in "why" and "search", never in the title or description.

Think like a menswear editor at GQ or Vogue: current, editorial and genuinely wearable, with the details that make a piece look considered (cut, proportion, fabric, colour pairing).

An idea is a concept, not a product: a specific kind of garment defined by cut, fabric, colour and details that real stores sell.

Variety:
- Every idea in a batch must be a clearly different garment: a different kind, fabric, collar, pattern or construction. Never the same garment in a few colours (e.g. three oxford shirts in blue, pink and white).
- When the request names kinds for the batch, use exactly those kinds, one per idea, each interpreted through his brief.
- Never repeat or closely copy anything in "Already shown".

His swipes:
- HEART: getting closer. Keep its kind and spirit, and change something meaningful in each variation (fabric, collar, pattern, fit, sleeve length, a detail) to zero in on the exact piece. At most one variation may differ only in colour.
- X: don't repeat that idea; its colour, fabric or style may still appear in other combinations. Several X in a row means: change direction clearly.
- Saved pieces are ones he liked enough to keep: a taste reference, not ideas to repeat.
- Long-term taste is a starting point; today's brief and today's swipes count more.
- Use exactly the requested type unless it is "Surprise me". Follow his styles, including anything he says he doesn't want.
- Think about Tel Aviv weather in the given month (long hot humid summers, short mild winters).

Reply with JSON only: {"insight": "...", "ideas": [ ... ]}. Each idea has exactly these fields:
- type: one of ${TYPES.join(", ")}
- title: up to 32 characters, sentence case, names the garment (e.g. "Madras check camp shirt")
- desc: one sentence, up to 80 characters, about how it looks and wears
- fit, fabric, colour, vibe: one or two words each, Title case; reuse the same words for the same things
- styles: one to three of ${STYLES.join(", ")}
- palette: three hex colours: main colour, secondary, a colour it pairs with
- why: "Because it was getting closer: <exact title>" when it builds on a hearted idea; otherwise the reference from his brief it follows (e.g. "Ralph Lauren-style rugby"), or "Something different" for an exploration, or ""
- search: 3 to 7 English words for a shopping search, starting with "men's"; may include a brand he named
- image_prompt: up to 250 characters describing only the garment itself for a product photo: exact colour, fabric and texture, collar, buttons, pockets, pattern, sleeve length, fit. No person, no body, no background.
insight: if today has 3 or more swipes, up to 70 characters on what you've learned, written to follow "Adjusting to you:", e.g. "more washed oxford and madras, less shiny fabrics". Otherwise "".

Example idea: ${JSON.stringify(EXAMPLE)}`;

// Kinds of each type. Every batch gets its own slice, so one search covers many different
// garments instead of one garment in many colours.
const KINDS = {
  "Shirts": ["Oxford button-down shirt", "Poplin shirt with a spread collar", "Linen shirt", "Camp-collar (Cuban) shirt", "Chambray or denim shirt", "Seersucker shirt", "Flannel or brushed-cotton shirt", "Gingham or madras check shirt", "Band-collar (grandad) shirt", "Knitted polo shirt", "Rugby shirt", "Western or workwear shirt", "Bengal or candy-stripe shirt", "Corduroy shirt", "Short-sleeve resort shirt", "Popover (half-placket) shirt"],
  "T-shirts": ["Heavyweight boxy tee", "Pocket tee", "Breton stripe tee", "Henley", "Ringer tee", "Slub-cotton crew neck", "Long-sleeve tee", "Waffle-knit tee", "Garment-dyed vintage tee", "Polo-collar tee", "Mock-neck tee", "Linen-blend tee"],
  "Overshirts": ["Chore-style overshirt", "Wool shirt jacket", "Corduroy overshirt", "Quilted overshirt", "Utility overshirt with flap pockets", "Denim overshirt", "Suede overshirt", "Flannel shacket", "Linen overshirt", "Waxed-cotton overshirt"],
  "Knitwear": ["Cable-knit crewneck", "Merino crewneck", "Shawl-collar cardigan", "Quarter-zip sweater", "Fisherman sweater", "Brushed mohair sweater", "Knitted polo", "Cotton cardigan", "Fair Isle sweater", "Ribbed turtleneck", "Cricket V-neck jumper", "Waffle-knit sweater"],
  "Jackets": ["Harrington jacket", "Denim trucker jacket", "Suede bomber", "Unstructured blazer", "Field jacket", "Waxed jacket", "Chore coat", "Coach jacket", "Overcoat", "Varsity jacket", "Quilted liner jacket", "Leather jacket"],
  "Trousers": ["Pleated chinos", "Straight-leg jeans", "Linen drawstring trousers", "Corduroy trousers", "Wool flannel trousers", "Fatigue trousers", "Carpenter trousers", "Wide-leg trousers", "Tapered chinos", "Seersucker trousers"],
  "Shorts": ["Pleated chino shorts", "Linen drawstring shorts", "Swim shorts", "Denim shorts", "Cargo shorts", "Seersucker shorts", "Rugby shorts", "Terry shorts"],
  "Shoes": ["White leather sneakers", "Penny loafers", "Suede desert boots", "Retro runners", "Canvas low-tops", "Boat shoes", "Chelsea boots", "Leather sandals", "Espadrilles", "Derby shoes", "Moccasins", "Tennis shoes"],
};
KINDS["Surprise me"] = TYPES.slice();

// What well-known brands stand for, so "Ralph Lauren meets J.Crew" turns into concrete clothes.
const BRANDS = [
  [/ralph\s*lauren|\bpolo\s+ralph|\brl\b/i, "Ralph Lauren: preppy American heritage. Oxford button-downs, madras and gingham, cable knits, chambray, rugby stripes, chinos, navy blazers. Navy, white, red, cream, forest green. Crisp, classic, a little rich."],
  [/j\.?\s*crew|jcrew/i, "J.Crew: classic American casual. Washed, broken-in oxfords and poplins, slub linen, garment-dyed tees, chambray, stripes, chinos. Relaxed and easy, softly faded colours."],
  [/abercrombie|a&f\b/i, "Abercrombie: clean, young American casual. Relaxed fits, linen-blend shirts, polos, washed tees, neutral colours."],
  [/banana\s*republic/i, "Banana Republic: polished smart-casual. Refined linen and cotton, knit polos, tailored chinos, earthy neutrals."],
  [/tommy|hilfiger/i, "Tommy Hilfiger: bright preppy. Navy, red and white, stripes, polos, oxford shirts, chinos."],
  [/lacoste/i, "Lacoste: French sporty-chic. Piqué polos, clean knits, tennis whites, bright solid colours."],
  [/\bgant\b/i, "Gant: East Coast preppy. Oxford shirts, rugby shirts, cable knits, classic colours."],
  [/uniqlo/i, "Uniqlo: simple essentials. Clean basics, oxford shirts, linen, Supima tees, quiet colours."],
  [/\bcos\b/i, "COS: Scandinavian minimal. Boxy shapes, clean lines, no visible details, muted neutrals."],
  [/arket/i, "Arket: modern Nordic basics. Sturdy natural fabrics, utility touches, muted colours."],
  [/massimo\s*dutti/i, "Massimo Dutti: refined Mediterranean smart-casual. Linen, suede, fine knits, earthy tones."],
  [/\bzara\b/i, "Zara: on-trend city fashion. Boxy and relaxed shapes, textured fabrics, current colours."],
  [/aim[eé]\s*leon\s*dore|\bald\b/i, "Aimé Leon Dore: New York prep meets streetwear. Vintage-inspired knits, rugby shirts, pleated trousers, rich muted colours."],
  [/todd\s*snyder/i, "Todd Snyder: American menswear with an edge. Italian fabrics, camp shirts, suede, military details."],
  [/drake'?s/i, "Drake's: English ivy. Oxford cloth, madras, chore jackets, Shetland knits, relaxed tailoring."],
  [/loro\s*piana|brunello|cucinelli|quiet\s*luxury|old\s*money/i, "Quiet luxury (Loro Piana, Brunello Cucinelli): understated, luxurious fabrics (cashmere, fine linen, suede), no logos, cream, camel, grey, soft blue."],
  [/sunspel/i, "Sunspel: refined English basics. Fine cotton tees and polos, clean and simple."],
  [/our\s*legacy|acne/i, "Our Legacy / Acne Studios: Scandinavian contemporary. Unusual fabrics, boxy cuts, washed colours."],
  [/\ba\.?p\.?c\.?(?=\s|$|[,.!])/i, "A.P.C.: Parisian minimal. Raw denim, clean shirts, quiet colours."],
  [/carhartt/i, "Carhartt WIP: workwear. Canvas, chore jackets, carpenter trousers, earthy colours."],
  [/st[uü]ssy|supreme/i, "Stüssy: surf-skate streetwear. Graphic tees, camp shirts, relaxed fits."],
  [/levi'?s/i, "Levi's: American denim heritage. Jeans, truckers, western shirts, washed tees."],
  [/\bboss\b|\bhugo\b/i, "Boss: sharp modern business-casual. Slim, clean, dark and neutral colours."],
];
const brandNotes = (text) => BRANDS.filter(([re]) => re.test(String(text || ""))).map(([, note]) => note);

// A seeded shuffle: batches of one search never overlap, and each search starts somewhere new.
function shuffled(list, seed) {
  const a = list.slice();
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  for (let i = a.length - 1; i > 0; i--) {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    const j = (h >>> 0) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Batch 0 is "your best bets"; batch n (1, 2, ...) takes the next slice of kinds.
function kindsFor(type, angle, seed, count, kindStart) {
  const list = KINDS[type] || KINDS["Surprise me"];
  const byOffset = Number.isInteger(kindStart) && kindStart >= 0;
  if (!byOffset && !(angle >= 1)) return [];
  const order = shuffled(list, seed || "drape");
  const start = (byOffset ? kindStart : (angle - 1) * count) % order.length;
  const out = [];
  for (let k = 0; k < Math.min(count, order.length); k++) out.push(order[(start + k) % order.length]);
  return out;
}

async function ideas(env, b) {
  const t0 = Date.now();
  const count = Math.max(1, Math.min(6, parseInt(b.count, 10) || 4));
  const q = b.query || {};
  const type = pickFrom(TYPES, q.type) || "Surprise me";
  const lines = [];
  lines.push("HIS BRIEF (the most important input; every idea must clearly answer it):");
  lines.push("- Looking for: " + type);
  if (Array.isArray(q.styles) && q.styles.length) lines.push("- Styles: " + q.styles.join(", "));
  if (q.text) lines.push('- In his words: "' + String(q.text).slice(0, 500) + '"');
  const notes = brandNotes(q.text);
  if (notes.length) { lines.push("- What the brands he named stand for:"); for (const n of notes) lines.push("  * " + n); }
  lines.push("Month: " + (b.month || new Date().toLocaleString("en", { month: "long" })));

  const hunt = b.converge && b.anchor;
  const kinds = hunt || b.anchor || b.redirect ? [] : kindsFor(type, parseInt(b.angle, 10), b.round, count, b.kindStart);
  const typeWord = type === "Surprise me" ? "garment" : type.toLowerCase();
  lines.push("");
  if (hunt) lines.push("He hearted this idea, it is getting closer to what he wants: " + describe(b.anchor) + ". Write " + count + " variations of it, each changing something meaningful (fabric, collar, pattern, fit, sleeve length or a detail). At most one may differ only in colour.");
  else if (b.anchor) lines.push("He picked this idea but didn't find the right product. Give close variations of it, each changing something meaningful: " + describe(b.anchor));
  else if (b.redirect) lines.push("He has said X to several ideas in a row: change direction clearly, with different kinds of " + typeWord + " than the ones he passed on.");
  else if (kinds.length) lines.push("Kinds for this batch, one idea each, in this order, each interpreted through his brief: " + kinds.join("; ") + ".");
  else lines.push("Your best bets for his brief: each a different kind of " + typeWord + ".");

  const round = Array.isArray(b.votes) ? b.votes.slice(-25) : [];
  lines.push("", "Today's votes, oldest first:" + (round.length ? "" : " none yet"));
  const WORD = { love: "PICKED TO BUY", like: "HEART", later: "X", hate: "X (strong)" };
  for (const v of round) lines.push("- " + (WORD[v.vote] || String(v.vote || "").toUpperCase()) + ": " + describe(v));

  const t = b.taste || {};
  if ((t.more && t.more.length) || (t.less && t.less.length) || (t.loved && t.loved.length) || (t.hated && t.hated.length) || (t.saved && t.saved.length)) {
    lines.push("", "Long-term taste from earlier sessions:");
    if (t.more && t.more.length) lines.push("More of: " + t.more.join(", "));
    if (t.less && t.less.length) lines.push("Less of: " + t.less.join(", "));
    if (t.saved && t.saved.length) lines.push("Saved by him (kept for later): " + t.saved.join("; "));
    if (t.loved && t.loved.length) lines.push("Hearted before: " + t.loved.join("; "));
    if (t.hated && t.hated.length) lines.push("Passed on before (not a hard no): " + t.hated.join("; "));
    if (t.picked && t.picked.length) lines.push("Picked to buy before: " + t.picked.join("; "));
  }
  if (Array.isArray(b.seen) && b.seen.length) lines.push("", "Already shown (don't repeat): " + b.seen.slice(-60).join("; "));
  const words = q.text ? ' Remember his words: "' + String(q.text).slice(0, 200) + '".' : "";
  lines.push("", `Write ${count} new ideas${kinds.length ? ", one per kind above" : ", best bet first"}.${words} JSON only.`);

  const messages = [{ role: "system", content: IDEAS_SYSTEM }, { role: "user", content: lines.join("\n") }];
  let out = null, used = TEXT_MODEL;
  if (textTrouble.until <= Date.now()) {
    try { out = await mainText(env, messages); }
    catch (e) {
      if (e instanceof HttpError && e.status === 429) throw e;
      // Slow or busy once: use the backup for this request only. A real failure: skip the main model for 10 minutes.
      const busy = e instanceof HttpError && e.status === 503;
      if (!busy) textTrouble = { until: Date.now() + 600 * 1000, error: String((e && e.message) || e).slice(0, 200) };
    }
    if (out && !Array.isArray(out.ideas)) out = null; // one odd reply: use the backup for this request only
  }
  if (!out) { used = TEXT_BACKUP; out = await backupText(env, messages); }
  if (!out || !Array.isArray(out.ideas)) throw new HttpError(502, "The AI's reply wasn't usable. Try again.");

  const list = out.ideas.slice(0, count).filter((i) => i && i.title).map((i) => ({
    id: "ai-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
    type: pickFrom(TYPES, i.type) || pickFrom(TYPES, q.type) || "Shirts",
    title: clip(i.title, 48),
    desc: clip(i.desc, 140),
    fit: clip(i.fit, 24), fabric: clip(i.fabric, 24), colour: clip(i.colour, 24), vibe: clip(i.vibe, 24),
    styles: (Array.isArray(i.styles) ? i.styles : []).map((s) => pickFrom(STYLES, s)).filter(Boolean).slice(0, 3),
    palette: fixPalette(i.palette),
    why: clip(i.why, 60),
    search: clip(i.search, 80) || ("men's " + clip(i.colour, 24) + " " + clip(i.title, 48)).toLowerCase(),
    image_prompt: clip(i.image_prompt || [i.colour, i.fabric, i.title].join(" "), 420),
  }));
  return { ideas: list, insight: clip(out.insight, 90), model: used.split("/").pop() + (used === TEXT_MODEL ? " (form " + mainForm + ")" : ""), ms: Date.now() - t0 };
}

const textModelNow = () => (textTrouble.until > Date.now() ? "llama-3.3-70b (gemma-4 failed: " + textTrouble.error + ")" : "gemma-4-26b-a4b-it");

// The reply's text, whatever shape the model returns it in (Workers AI "response", or OpenAI-style "choices").
function textOf(r) {
  if (r == null) return "";
  if (typeof r === "string") return r;
  if (r.response != null) return r.response;
  const c = Array.isArray(r.choices) && r.choices[0];
  if (c) {
    const m = c.message || {};
    if (Array.isArray(m.content)) return m.content.map((x) => (x && (x.text || x.content)) || "").join("");
    if (m.content != null) return m.content;
    if (c.text != null) return c.text;
  }
  if (r.output_text) return r.output_text;
  if (Array.isArray(r.output)) return r.output.flatMap((o) => (o && Array.isArray(o.content) ? o.content : [])).map((x) => (x && x.text) || "").join("");
  return r;
}
// Settings the model doesn't accept come back as a quick validation error: try the next, simpler form.
const settingRejected = (e) => e instanceof HttpError && e.status !== 429 && /propert|5006|schema|invalid|unknown|unsupported|response_format|max_completion/i.test(e.message);
// Which request form the model accepted last time (so later calls skip the ones it rejects).
let mainForm = 0;
async function mainText(env, messages) {
  const tries = [
    { messages, max_completion_tokens: 2400, temperature: 0.8, response_format: { type: "json_object" }, chat_template_kwargs: { enable_thinking: false } },
    { messages, max_completion_tokens: 2400, temperature: 0.8, response_format: { type: "json_object" } },
    { messages, max_completion_tokens: 2400, temperature: 0.8 },
    { messages, max_tokens: 2400, temperature: 0.8 },
  ];
  let last;
  for (let i = mainForm; i < tries.length; i++) {
    try {
      const out = parseJSON(textOf(await timeLimit(runAI(env, TEXT_MODEL, tries[i]), +env.TEXT_LIMIT_MS || 25000, "Gemma")));
      mainForm = i;
      return out;
    }
    catch (e) { last = e; if (!settingRejected(e)) throw e; }
  }
  throw last;
}
async function backupText(env, messages) {
  let out = null;
  try {
    out = parseJSON(textOf(await timeLimit(runAI(env, TEXT_BACKUP, { messages, max_tokens: 2400, temperature: 0.8, response_format: { type: "json_schema", json_schema: IDEA_SCHEMA } }), 40000, "Llama")));
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw e;
  }
  // JSON mode can fail ("couldn't be met"); ask once more as plain text and pull the JSON out.
  if (!out || !Array.isArray(out.ideas)) out = parseJSON(textOf(await timeLimit(runAI(env, TEXT_BACKUP, { messages, max_tokens: 2400, temperature: 0.7 }), 40000, "Llama")));
  return out;
}

function parseJSON(r) {
  if (r && typeof r === "object") return r;
  const s = String(r || "");
  try { return JSON.parse(s); } catch (e) {}
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) {} }
  // Pull the JSON object out of any text around it (start from the one that holds "ideas").
  const z = s.lastIndexOf("}"), k = s.indexOf('"ideas"');
  const starts = [k > 0 ? s.lastIndexOf("{", k) : -1, s.indexOf("{")].filter((x) => x >= 0);
  for (const a of starts) if (z > a) { try { return JSON.parse(s.slice(a, z + 1)); } catch (e) {} }
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

/* ---------------- /products and /more: real products from real stores ----------------
   Shopify stores answer a public product search at /search/suggest.json (the one their own search box
   uses): free, no keys, real photos, prices and links. Checked live on 20 Oct 2026 (tests/store-probe.mjs).
   /products: one search (a kind of garment) across the stores that best fit the brief. No AI.
   /more:     Gemma turns a heart (or the brief) into 2-3 short searches, then searches them. */

// Stores that answered with real products in the live check, with what they're like.
const STORES = [
  { d: "rowingblazers.com", name: "Rowing Blazers", cur: "USD", tags: ["preppy", "vintage", "youthful", "classic"] },
  { d: "alexmill.com", name: "Alex Mill", cur: "USD", tags: ["classic", "relaxed", "minimal", "preppy"] },
  { d: "toddsnyder.com", name: "Todd Snyder", cur: "USD", tags: ["classic", "tailored", "preppy", "smart"] },
  { d: "drakes.com", name: "Drake's", cur: "USD", tags: ["preppy", "classic", "tailored", "luxe"] },
  { d: "aimeleondore.com", name: "Aimé Leon Dore", cur: "USD", tags: ["preppy", "streetwear", "youthful", "luxe"] },
  { d: "taylorstitch.com", name: "Taylor Stitch", cur: "USD", tags: ["workwear", "classic", "relaxed", "vintage"] },
  { d: "noahny.com", name: "Noah", cur: "USD", tags: ["preppy", "streetwear", "youthful"] },
  { d: "percivalclo.com", name: "Percival", cur: "GBP", tags: ["smart", "minimal", "youthful", "relaxed"] },
  { d: "portugueseflannel.com", name: "Portuguese Flannel", cur: "EUR", tags: ["relaxed", "classic", "minimal"] },
  { d: "bonobos.com", name: "Bonobos", cur: "USD", tags: ["smart", "classic", "tailored"] },
  { d: "ledbury.com", name: "Ledbury", cur: "USD", tags: ["smart", "tailored", "classic"] },
  { d: "oliverspencer.co.uk", name: "Oliver Spencer", cur: "GBP", tags: ["smart", "minimal", "relaxed"] },
  { d: "universalworks.co.uk", name: "Universal Works", cur: "GBP", tags: ["workwear", "relaxed", "vintage"] },
  { d: "kith.com", name: "Kith", cur: "USD", tags: ["streetwear", "youthful", "preppy"] },
  { d: "corridornyc.com", name: "Corridor", cur: "USD", tags: ["relaxed", "smart", "vintage"] },
  { d: "knickerbocker.nyc", name: "Knickerbocker", cur: "USD", tags: ["vintage", "workwear", "classic"] },
  { d: "outerknown.com", name: "Outerknown", cur: "USD", tags: ["relaxed", "surf", "minimal"] },
  { d: "ironandresin.com", name: "Iron & Resin", cur: "USD", tags: ["workwear", "vintage", "rugged"] },
  { d: "howlerbros.com", name: "Howler Brothers", cur: "USD", tags: ["surf", "relaxed", "sporty"] },
];
const STORE_BY_DOMAIN = Object.fromEntries(STORES.map((s) => [s.d, s]));

// What the brief asks for, as store tags: chips, and brands or words in his own text.
const STYLE_TAGS = { "Relaxed": ["relaxed"], "Minimal": ["minimal"], "Smart-casual": ["smart", "classic", "tailored"], "Streetwear": ["streetwear", "youthful"], "Vintage": ["vintage", "workwear"], "Sporty": ["sporty", "surf"] };
const TEXT_TAGS = [
  [/ralph\s*lauren|\bpolo\s+ralph|\brl\b|preppy|ivy|old money/i, ["preppy", "classic"]],
  [/j\.?\s*crew|jcrew/i, ["classic", "relaxed", "preppy"]],
  [/aim[eé]\s*leon\s*dore|\bald\b/i, ["preppy", "youthful", "streetwear"]],
  [/younger|young|youthful|modern|fresh/i, ["youthful"]],
  [/workwear|rugged|carhartt/i, ["workwear", "rugged"]],
  [/minimal|clean|cos\b|uniqlo/i, ["minimal"]],
  [/street|kith|st[uü]ssy|supreme/i, ["streetwear"]],
  [/beach|surf|summer/i, ["surf", "relaxed"]],
  [/tailor|smart|office|work\b/i, ["smart", "tailored"]],
  [/luxur|quiet luxury|loro|brunello/i, ["luxe"]],
];
function briefTags(q) {
  const t = {};
  for (const s of (Array.isArray(q.styles) ? q.styles : [])) for (const x of STYLE_TAGS[s] || []) t[x] = (t[x] || 0) + 1;
  for (const [re, xs] of TEXT_TAGS) if (re.test(String(q.text || ""))) for (const x of xs) t[x] = (t[x] || 0) + 2;
  return t;
}
// The stores that fit the brief best, each with a little randomness so searches don't always look the same.
function storesFor(q, n, seed) {
  const t = briefTags(q);
  const scored = STORES.map((s, ix) => [s, s.tags.reduce((a, x) => a + (t[x] || 0), 0) + ((hash(String(seed) + s.d) % 100) / 100) * 1.5 - ix * 0.01]);
  return scored.sort((a, b) => b[1] - a[1]).slice(0, n).map((x) => x[0]);
}
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

// A short search per kind of garment (what a store's search box understands).
const KIND_QUERY = {
  "Oxford button-down shirt": "oxford shirt", "Poplin shirt with a spread collar": "poplin shirt", "Linen shirt": "linen shirt",
  "Camp-collar (Cuban) shirt": "camp collar shirt", "Chambray or denim shirt": "chambray shirt", "Seersucker shirt": "seersucker shirt",
  "Flannel or brushed-cotton shirt": "flannel shirt", "Gingham or madras check shirt": "madras shirt", "Band-collar (grandad) shirt": "band collar shirt",
  "Knitted polo shirt": "knit polo", "Rugby shirt": "rugby shirt", "Western or workwear shirt": "western shirt", "Bengal or candy-stripe shirt": "striped shirt",
  "Corduroy shirt": "corduroy shirt", "Short-sleeve resort shirt": "short sleeve shirt", "Popover (half-placket) shirt": "popover shirt",
};
const kindQuery = (k) => KIND_QUERY[k] || String(k).replace(/\(.*?\)/g, "").split(/\s+or\s+/)[0].replace(/\s+/g, " ").trim().toLowerCase();

const NOT_HIS = /\b(women|womens|women's|woman|ladies|girls?|kids?|boys?|baby|toddler|unisex kids)\b/i;
const NOT_CLOTHES = /\b(gift card|candle|mug|poster|sticker|book|magazine|keychain|key ring|umbrella|towel|blanket|fragrance|perfume|cologne|incense|print|pin|patch|sample|e-gift|giftcard|bundle)\b/i;
const FABRICS = ["oxford", "poplin", "linen", "seersucker", "chambray", "denim", "flannel", "madras", "gingham", "corduroy", "twill", "jersey", "pique", "piqué", "terry", "cashmere", "merino", "wool", "silk", "suede", "leather", "canvas", "cotton", "knit", "fleece", "nylon", "seersucker", "herringbone", "stripe", "striped", "plaid", "check"];
const COLOURS = ["navy", "blue", "light blue", "sky", "white", "ecru", "cream", "ivory", "bone", "oat", "oatmeal", "sand", "stone", "khaki", "tan", "camel", "brown", "chocolate", "olive", "green", "forest", "sage", "mint", "teal", "grey", "gray", "charcoal", "black", "red", "burgundy", "wine", "pink", "rose", "coral", "orange", "rust", "yellow", "mustard", "gold", "purple", "lavender", "indigo"];
const findWord = (list, s) => { const t = String(s).toLowerCase(); let best = ""; for (const w of list) if (new RegExp("\\b" + w + "\\b").test(t) && w.length > best.length) best = w; return best; };
const title1 = (s) => String(s || "").replace(/\s+/g, " ").trim();
const cap = (s) => s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : "";
function imgSized(u, w) {
  if (!u) return "";
  u = String(u).startsWith("//") ? "https:" + u : String(u);
  return u + (u.includes("?") ? "&" : "?") + "width=" + w;
}

// One store's answer to one search, normalized. Cached at Cloudflare's edge for 6 hours.
async function storeSearch(store, q, limit) {
  const u = `https://${store.d}/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=${limit || 10}&resources[options][unavailable_products]=hide`;
  const res = await fetch(u, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; Drape/1.0; personal shopping app)" }, cf: { cacheTtl: 21600, cacheEverything: true } });
  if (!res.ok) throw new Error(store.d + " " + res.status);
  const j = await res.json();
  const list = (j && j.resources && j.resources.results && j.resources.results.products) || [];
  return list.map((p, ix) => {
    const t = title1(p.title), img = p.image || (p.featured_image && p.featured_image.url) || "";
    const path = String(p.url || "").split("?")[0];
    return {
      id: "p-" + store.d.split(".")[0] + "-" + (p.id || p.handle || path.split("/").pop()),
      store: store.name, domain: store.d, brand: title1(p.vendor) && !/^(ok mens|drakes - uk\/row)$/i.test(p.vendor) ? title1(p.vendor) : store.name,
      title: t, price: Number(p.price) || 0, currency: store.cur, url: path ? "https://" + store.d + path : "https://" + store.d,
      image: imgSized(img, 900), type: title1(p.type), tags: Array.isArray(p.tags) ? p.tags.slice(0, 12) : [],
      available: p.available !== false, rank: ix,
      fabric: cap(findWord(FABRICS, t)), colour: cap(findWord(COLOURS, t)),
    };
  }).filter((p) => p.image && p.available && !NOT_HIS.test(p.title + " " + p.type + " " + p.tags.join(" ")) && !NOT_CLOTHES.test(p.title + " " + p.type));
}

// Search several stores for one query; return a varied pick (best of each store first).
async function searchStores(stores, q, opts) {
  opts = opts || {};
  const t0 = Date.now(), timing = {};
  const results = await Promise.all(stores.map((s) => timeLimit(storeSearch(s, q, 10), 6000, s.d)
    .then((r) => { timing[s.d] = Date.now() - t0; return r; })
    .catch((e) => { timing[s.d] = "failed: " + String(e.message || e).slice(0, 60); return []; })));
  const exclude = new Set(opts.exclude || []);
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !/^(shirt|shirts|men|mens)$/.test(w));
  const lists = results.map((list) => list.filter((p) => !exclude.has(p.id))
    // the store's own order, nudged towards titles that contain the search words
    .map((p) => [p, -p.rank + words.filter((w) => p.title.toLowerCase().includes(w)).length * 3])
    .sort((a, b) => b[1] - a[1]).map((x) => x[0]));
  const out = [], per = opts.perStore || 2, limit = opts.limit || 10;
  for (let round = 0; round < per && out.length < limit; round++)
    for (const l of lists) if (l[round] && out.length < limit) out.push(l[round]);
  return { products: out, timing };
}

async function products(env, b) {
  const q = b.query || {};
  const type = pickFrom(TYPES, q.type) || "Surprise me";
  const n = Math.max(1, Math.min(4, parseInt(b.kinds, 10) || 1));
  const kinds = kindsFor(type, 0, b.round || "drape", n, Math.max(0, parseInt(b.kindStart, 10) || 0));
  const per = Math.min(10, Math.max(3, Math.floor(40 / kinds.length))); // stay under the free plan's 50 subrequests per request
  const stores = storesFor(q, Math.min(per, STORES.length), (b.round || "") + ":" + (b.kindStart || 0));
  const out = [], timing = {};
  for (const r of await Promise.all(kinds.map((k) => searchStores(stores, kindQuery(k), { exclude: b.exclude, limit: b.limit || 10 }).then((x) => ({ k, ...x }))))) {
    for (const p of r.products) out.push({ ...p, why: kindLabel(r.k), kind: r.k, query: kindQuery(r.k) });
    Object.assign(timing, r.timing);
  }
  return { products: out, stores: stores.map((s) => s.name), timing };
}
const kindLabel = (k) => String(k).replace(/\s*\(.*?\)/g, "");

// A heart (or just the brief): Gemma writes 2-3 short searches, then those are searched.
const MORE_SYSTEM = `You help one man in Tel Aviv find a specific piece of menswear in real online stores (Rowing Blazers, Alex Mill, Todd Snyder, Drake's, Aimé Leon Dore, Taylor Stitch, Noah, Percival, Portuguese Flannel and similar). Write short searches for a store's search box: 2 to 4 plain words each, no brand names, e.g. "striped oxford shirt", "madras camp shirt", "garment dyed rugby". Reply with JSON only: {"queries": ["...", "..."], "why": "up to 40 characters"}.`;
async function more(env, b) {
  const q = b.query || {};
  const p = b.product || null;
  const lines = [];
  lines.push("His brief: " + [q.type, (q.styles || []).join(", "), q.text ? '"' + String(q.text).slice(0, 300) + '"' : ""].filter(Boolean).join(" · "));
  if (p) lines.push("He just hearted: " + [p.title, p.brand, p.colour, p.fabric].filter(Boolean).join(", ") + ". Write 3 searches for close alternatives: the same kind of piece with one thing changed (colour, fabric, pattern, collar), and one search for the exact same kind.");
  else lines.push("Write 3 searches that capture his brief, each a different kind of " + String(q.type || "garment").toLowerCase() + ".");
  const liked = (b.liked || []).slice(-6), passed = (b.passed || []).slice(-8);
  if (liked.length) lines.push("He also hearted: " + liked.join("; "));
  if (passed.length) lines.push("He passed on: " + passed.join("; "));
  let queries = [], why = "", model = "";
  try {
    const out = await mainText(env, [{ role: "system", content: MORE_SYSTEM }, { role: "user", content: lines.join("\n") + "\nJSON only." }]);
    queries = (out && Array.isArray(out.queries) ? out.queries : []).map((x) => clip(String(x).toLowerCase().replace(/[^a-z0-9 '-]/g, " ").replace(/\s+/g, " "), 40)).filter(Boolean).slice(0, 3);
    why = clip(out && out.why, 50); model = "gemma";
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw e;
  }
  // No AI (or it failed): search for the hearted piece's own kind and fabric.
  if (!queries.length) {
    queries = p ? [[p.fabric, p.query || "shirt"].filter(Boolean).join(" ").toLowerCase(), p.query || ""].filter(Boolean) : [kindQuery((KINDS[pickFrom(TYPES, q.type) || "Surprise me"] || ["shirt"])[0])];
    model = "none";
  }
  // Stay under 50 subrequests: up to 3 searches x up to 7 stores (+1 for the AI).
  const stores = storesFor(q, 7, b.round || "more");
  if (p && p.domain && STORE_BY_DOMAIN[p.domain] && !stores.includes(STORE_BY_DOMAIN[p.domain])) stores[stores.length - 1] = STORE_BY_DOMAIN[p.domain];
  const out = [], seen = new Set(b.exclude || []);
  if (p && p.id) seen.add(p.id);
  for (const r of await Promise.all(queries.map((x) => searchStores(stores, x, { exclude: [...seen], limit: 4, perStore: 1 }).then((y) => ({ x, ...y }))))) {
    for (const prod of r.products) if (!seen.has(prod.id)) { seen.add(prod.id); out.push({ ...prod, why: p ? "More like: " + clip(p.title, 34) : clip(why || r.x, 40), query: r.x }); }
  }
  return { products: out, queries, model };
}

/* ---------------- /image ---------------- */

// Product photos, like a store's: the garment alone on an invisible mannequin. No person means
// no odd heads or hands, and the garment looks like something you can actually buy.
const SHOE_WORDS = /\b(sneakers?|trainers?|loafers?|boots?|sandals?|espadrilles?|derbys?|derbies|moccasins?|mules?|slides|runners|low-tops?|shoes?)\b/i;
const PERSON_BITS = /\b(worn|wearing|wears|framed|frame|face|faces|man|men|model|person|people|head|hands?|feet|body|torso|backdrop|background|studio|photo|catalogue|catalog)\b/i;

// Older ideas described a man wearing the piece; keep only the parts about the garment.
function cleanPrompt(p) {
  const parts = String(p || "").split(/[,.;]/).map((x) => x.trim()).filter(Boolean);
  const keep = parts.filter((x, ix) => ix === 0 || !PERSON_BITS.test(x));
  return keep.join(", ").replace(/\s*\b(worn|wearing)\b.*$/i, "").replace(/\s+by a man\b.*$/i, "").trim();
}
function productPrompt(p, type) {
  const g = cleanPrompt(p) || clip(p, 300);
  const shoes = type === "Shoes" || (!type && SHOE_WORDS.test(g) && !/\b(shirt|tee|jacket|trousers|shorts|sweater)\b/i.test(g));
  if (shoes) return `Professional e-commerce product photo of a pair of men's shoes: ${g}. Three-quarter side view, both shoes, centered, on a plain light grey background, soft even studio light, sharp material detail, true-to-life colours. No feet, no person, no text, no logos.`;
  const lower = type === "Trousers" || type === "Shorts";
  return `Professional e-commerce product photo of a men's garment: ${g}. Shown alone on an invisible ghost mannequin (hollow inside, no person, no head, no hands), front view, ${lower ? "full length from waistband to hem" : "whole garment in frame, collar to hem"}, centered, on a plain light grey background, soft even studio light, sharp fabric texture, true-to-life colours, realistic real-world garment construction. No text, no logos, no watermark.`;
}
const imageModelNow = () => "schnell for the first cards, klein after" + (imageTrouble.until > Date.now() ? " (" + imageTrouble.model + " failed: " + imageTrouble.error + ")" : "");

async function runKlein(env, prompt) {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(IMG_W));
  form.append("height", String(IMG_H));
  // FormData has no body or boundary of its own: a Response serializes it and sets the Content-Type.
  const r = new Response(form);
  return runAI(env, "@cf/black-forest-labs/flux-2-klein-4b", { multipart: { body: r.body, contentType: r.headers.get("content-type") } });
}
async function runSchnell(env, prompt) {
  try {
    return await runAI(env, "@cf/black-forest-labs/flux-1-schnell", { prompt, steps: 4 });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status === 429 || !/propert|5006|schema|invalid/i.test(e.message)) throw e;
    return runAI(env, "@cf/black-forest-labs/flux-1-schnell", { prompt });
  }
}

async function image(env, prompt, type, origin, fast) {
  prompt = clip(prompt, 600);
  if (!prompt) throw new HttpError(400, "Missing prompt");
  const full = productPrompt(prompt, pickFrom(TYPES, type));
  const order = fast
    ? [["flux-1-schnell", () => runSchnell(env, full), +env.IMAGE_LIMIT_MS || 15000], ["flux-2-klein-4b", () => runKlein(env, full), 30000]]
    : [["flux-2-klein-4b", () => runKlein(env, full), +env.IMAGE_LIMIT_MS || 30000], ["flux-1-schnell", () => runSchnell(env, full), 15000]];
  if (imageTrouble.until > Date.now() && imageTrouble.model === order[0][0]) order.reverse();
  let bytes = null, used = "", last = null;
  for (const [name, run, ms] of order) {
    try { bytes = await imageBytes(await timeLimit(run(), ms, name)); used = name; break; }
    catch (e) {
      if (e instanceof HttpError && e.status === 429) throw e;
      last = e;
      // Slow once: just use the other model this time. A real failure: skip this model for 10 minutes.
      if (!(e instanceof HttpError && e.status === 503)) imageTrouble = { until: Date.now() + 600 * 1000, model: name, error: String((e && e.message) || e).slice(0, 200) };
    }
  }
  if (!bytes) throw last;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50;
  const headers = { "Content-Type": png ? "image/png" : "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable", "X-Drape-Image-Model": used, ...cors(origin) };
  return new Response(bytes, { headers });
}

// Models have returned a base64 string, raw bytes or a stream; accept all of them.
async function imageBytes(out) {
  if (out instanceof ReadableStream) return new Uint8Array(await new Response(out).arrayBuffer());
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (ArrayBuffer.isView(out)) return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  let b64 = out && (out.image || out.result || (typeof out === "string" ? out : ""));
  if (b64 && typeof b64 === "object" && b64.image) b64 = b64.image;
  if (typeof b64 !== "string" || !b64) throw new HttpError(502, "The image model returned nothing usable (" + Object.keys(out || {}).join(",") + ")");
  b64 = b64.replace(/^data:image\/\w+;base64,/, "");
  const bin = atob(b64);
  if (bin.length < 100) throw new HttpError(502, "The image model returned an empty image");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ---------------- /diag ---------------- */
// One tiny call per model (a few tokens, one small picture: almost free), each with Cloudflare's exact
// answer, so a report shows what's really wrong instead of a guess.
async function diag(env) {
  const out = { version: SERVER_VERSION, at: new Date().toISOString() };
  const msg = [{ role: "user", content: "Reply with the word ok." }];
  const tryIt = async (name, fn) => {
    const t0 = Date.now();
    try { const r = await timeLimit(fn(), 25000, name); out[name] = "ok " + (Date.now() - t0) + "ms" + (r ? ": " + r : ""); }
    catch (e) { out[name] = "FAILED " + (Date.now() - t0) + "ms: " + String((e && e.message) || e).slice(0, 300); }
  };
  await tryIt("gemma", async () => clip(String(textOf(await rawRun(env, TEXT_MODEL, { messages: msg, max_completion_tokens: 5 }))), 20));
  await tryIt("llama", async () => clip(String(textOf(await rawRun(env, TEXT_BACKUP, { messages: msg, max_tokens: 5 }))), 20));
  await tryIt("schnell", async () => (await imageBytes(await rawRun(env, IMAGE_MODEL, { prompt: "a plain white t-shirt on a grey background", steps: 1 }))).length + " bytes");
  await tryIt("klein", async () => {
    const form = new FormData();
    form.append("prompt", "a plain white t-shirt on a grey background"); form.append("width", "256"); form.append("height", "256");
    const r = new Response(form);
    const bytes = await imageBytes(await rawRun(env, IMAGE_BACKUP, { multipart: { body: r.body, contentType: r.headers.get("content-type") } }));
    return bytes.length + " bytes";
  });
  out.textModelNow = textModelNow(); out.imageModelNow = imageModelNow();
  return out;
}
// Like runAI, but keeps Cloudflare's error exactly as it came.
async function rawRun(env, model, input) {
  if (!env.AI) throw new Error("The Workers AI binding isn't set up");
  return env.AI.run(model, input);
}
