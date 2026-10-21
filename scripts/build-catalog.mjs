// Builds Drape's product catalog: real menswear from real stores, saved as small JSON files that
// GitHub Pages serves next to the app. The app searches them on the phone: instant, and no store
// ever sees a burst of requests from us (live searches from the worker got rate-limited).
// Run daily by .github/workflows/catalog.yml. Uses each Shopify store's public /products.json.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(process.env.OUT || "catalog");
fs.mkdirSync(OUT, { recursive: true });
const UA = "Mozilla/5.0 (compatible; DrapeCatalog/1.0; personal menswear app; +https://israeltoledano.github.io/Clothes/)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stores, what they're like (for matching a brief), and whether they ship to Israel (from each store's /meta.json).
const STORES = [
  { d: "rowingblazers.com", name: "Rowing Blazers", tags: ["preppy", "vintage", "youthful", "classic"] },
  { d: "alexmill.com", name: "Alex Mill", tags: ["classic", "relaxed", "minimal", "preppy"] },
  { d: "toddsnyder.com", name: "Todd Snyder", tags: ["classic", "tailored", "preppy", "smart"] },
  { d: "drakes.com", name: "Drake's", tags: ["preppy", "classic", "tailored", "luxe"] },
  { d: "aimeleondore.com", name: "Aimé Leon Dore", tags: ["preppy", "streetwear", "youthful", "luxe"] },
  { d: "taylorstitch.com", name: "Taylor Stitch", tags: ["workwear", "classic", "relaxed", "vintage"] },
  { d: "noahny.com", name: "Noah", tags: ["preppy", "streetwear", "youthful"] },
  { d: "percivalclo.com", name: "Percival", tags: ["smart", "minimal", "youthful", "relaxed"] },
  { d: "portugueseflannel.com", name: "Portuguese Flannel", tags: ["relaxed", "classic", "minimal"] },
  { d: "oliverspencer.co.uk", name: "Oliver Spencer", tags: ["smart", "minimal", "relaxed"] },
  { d: "universalworks.co.uk", name: "Universal Works", tags: ["workwear", "relaxed", "vintage"] },
  { d: "kith.com", name: "Kith", tags: ["streetwear", "youthful", "preppy"] },
  { d: "corridornyc.com", name: "Corridor", tags: ["relaxed", "smart", "vintage"] },
  { d: "outerknown.com", name: "Outerknown", tags: ["relaxed", "surf", "minimal"] },
  { d: "howlerbros.com", name: "Howler Brothers", tags: ["surf", "relaxed", "sporty"] },
  { d: "ledbury.com", name: "Ledbury", tags: ["smart", "tailored", "classic"] },
  { d: "knickerbocker.nyc", name: "Knickerbocker", tags: ["vintage", "workwear", "classic"] },
  { d: "ironandresin.com", name: "Iron & Resin", tags: ["workwear", "vintage", "rugged"] },
  { d: "bonobos.com", name: "Bonobos", tags: ["smart", "classic", "tailored"] },
];

const NOT_HIS = /\b(women|womens|women's|women’s|woman|ladies|girls?|kids?|boys?|baby|toddler|skirts?|blouses?|bralettes?|bikinis?|leggings?|camisoles?|bodysuits?|jumpsuits?|rompers?|maternity|corsets?|bras?|halter|crop tops?|scarf tank|wrap top)\b|\bdress(es)?\b(?!\s*shirts?)/i;
const NOT_CLOTHES = /\b(ties?|bow ?ties?|neckties?|socks?|hats?|caps?|beanies?|scarf|scarves|belts?|bags?|totes?|backpacks?|wallets?|card holders?|gloves?|sunglasses|glasses|jewel(le)?ry|bracelets?|necklaces?|rings?|cufflinks?|pocket squares?|bandanas?|keyrings?|watch(es)?|watch straps?|laces|shoe care|cream|polish|brush|hangers?|mask|face covering|gift ?card|e-?gift|candle|mug|poster|sticker|book|magazine|keychain|key ring|umbrella|towel|blanket|fragrance|perfume|cologne|incense|print|pin|patch|sample|bundle|insurance|shipping|donation|cushion|pillow|rug|ornament|playing cards|dog|leash|collar for)\b/i;

// The app's types. First match wins, so the more specific ones come first.
const TYPE_RULES = [
  ["Shoes", /\b(footwear|sneakers?|trainers?|shoes?|boots?|loafers?|sandals?|derbys?|derbies|moccasins?|mules?|slides|espadrilles?|clogs?|slippers?|oxfords? (shoes?|sneakers?)|tennis oxfords?)\b/i],
  ["Shorts", /\b(shorts|short)\b(?!\s*-?\s*sleeve)|\bswim ?trunks?\b|\bboardshorts?\b/i],
  ["Trousers", /\b(pants?|trousers?|chinos?|jeans|denim pant|slacks|joggers?|sweatpants)\b/i],
  ["Overshirts", /\b(overshirts?|over-shirts?|shirt jackets?|shirt-jackets?|shackets?|chore (coats?|jackets?))\b/i],
  ["Jackets", /\b(jackets?|blazers?|coats?|parkas?|bombers?|anoraks?|gilets?|vests?|waistcoats?|cagoules?|windbreakers?|sport ?coats?|overcoats?|peacoats?|suits?|suit outfit|tuxedos?(?! shirt))\b/i],
  ["T-shirts", /\b(t-?shirts?|tees?|henleys?|ringer|tank tops?)\b/i],
  ["Knitwear", /\b(sweaters?|cardigans?|jumpers?|knits?|knitted|crewnecks?|quarter[- ]zip|half[- ]zip|turtlenecks?|mock ?necks?|pullovers?|cashmere|merino|fair isle|cable)\b/i],
  ["Shirts", /\b(shirts?|oxfords?|popovers?|button[- ]downs?|polos?|rugbys?|camp collar|flannels?|chambray|overshirts?)\b/i],
];
function typeOf(p) {
  const hay = [p.title, p.product_type].join(" ");
  for (const [t, re] of TYPE_RULES) if (re.test(p.product_type || "") ) return t;
  for (const [t, re] of TYPE_RULES) if (re.test(hay)) return t;
  return "";
}
const FABRICS = ["oxford", "poplin", "linen", "seersucker", "chambray", "denim", "flannel", "madras", "gingham", "corduroy", "twill", "jersey", "pique", "terry", "cashmere", "merino", "wool", "silk", "suede", "leather", "canvas", "cotton", "fleece", "nylon", "herringbone", "tweed", "mohair", "boucle", "waffle", "velvet"];
const COLOURS = ["navy", "light blue", "sky blue", "blue", "white", "ecru", "cream", "ivory", "bone", "oatmeal", "oat", "sand", "stone", "khaki", "tan", "camel", "brown", "chocolate", "olive", "forest", "green", "sage", "mint", "teal", "grey", "gray", "charcoal", "black", "red", "burgundy", "wine", "pink", "rose", "coral", "orange", "rust", "yellow", "mustard", "gold", "purple", "lavender", "indigo"];
const findWord = (list, s) => { const t = String(s).toLowerCase(); for (const w of list) if (new RegExp("\\b" + w + "\\b").test(t)) return w; return ""; };
const cap = (s) => (s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : "");
const sized = (u, w) => { if (!u) return ""; u = String(u).startsWith("//") ? "https:" + u : String(u); return u + (u.includes("?") ? "&" : "?") + "width=" + w; };
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function getJSON(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(25000) }).catch((e) => ({ ok: false, status: String(e.message || e) }));
    if (r.ok) { try { return await r.json(); } catch (e) { return null; } }
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    throw new Error("HTTP " + r.status);
  }
  throw new Error("gave up after retries");
}

const byType = {}, report = [];
for (const [si, s] of STORES.entries()) {
  const t0 = Date.now(), rep = { store: s.d, pages: 0, raw: 0, kept: 0 };
  try {
    const meta = await getJSON(`https://${s.d}/meta.json`).catch(() => null);
    s.cur = (meta && meta.currency) || "USD";
    s.il = meta && Array.isArray(meta.ships_to_countries) ? meta.ships_to_countries.includes("IL") : null;
    for (let page = 1; page <= 12; page++) {
      const j = await getJSON(`https://${s.d}/products.json?limit=250&page=${page}`);
      const list = (j && j.products) || [];
      rep.pages = page; rep.raw += list.length;
      for (const p of list) {
        const title = clean(p.title), ptype = clean(p.product_type), tags = (Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",")).map((x) => clean(x).toLowerCase()).filter(Boolean);
        const hay = [title, ptype, tags.join(" ")].join(" ");
        if (NOT_HIS.test(hay) || NOT_CLOTHES.test(title + " " + ptype)) continue;
        const variants = (p.variants || []).filter((v) => v.available !== false);
        if (!variants.length) continue;
        const imgs = (p.images || []).map((im) => im && im.src).filter(Boolean);
        if (!imgs.length) continue;
        const type = typeOf({ title, product_type: ptype });
        if (!type) continue;
        const price = Math.min(...variants.map((v) => Number(v.price) || Infinity));
        const sizes = [...new Set(variants.map((v) => clean(v.option1 || v.title)).filter((x) => x && x.length <= 6))].slice(0, 10);
        (byType[type] = byType[type] || []).push({
          id: "p-" + s.d.split(".")[0] + "-" + p.id, s: si, t: title, pt: ptype,
          h: p.handle, p: Number.isFinite(price) ? price : 0,
          im: imgs.slice(0, 3).map((u) => sized(u, 900)),
          c: cap(findWord(COLOURS, title + " " + variants.map((v) => v.title).slice(0, 1).join(" "))), f: cap(findWord(FABRICS, title + " " + ptype + " " + tags.join(" "))),
          tg: tags.filter((x) => x.length <= 24 && !/^(sale|new|yotpo|size|_|filter|price|gid:)/.test(x)).slice(0, 12),
          sz: sizes, d: String(p.published_at || p.created_at || "").slice(0, 10),
        });
        rep.kept++;
      }
      if (list.length < 250) break;
      await sleep(800);
    }
  } catch (e) { rep.error = String(e.message || e); }
  rep.ms = Date.now() - t0;
  report.push(rep);
  console.log(JSON.stringify(rep));
}

const stores = STORES.map((s) => ({ d: s.d, name: s.name, tags: s.tags, cur: s.cur || "USD", il: s.il }));
const counts = {};
for (const [t, list] of Object.entries(byType)) {
  // newest first within each store keeps the catalog fresh-looking
  list.sort((a, b) => (b.d || "").localeCompare(a.d || ""));
  fs.writeFileSync(path.join(OUT, t.toLowerCase().replace(/[^a-z]+/g, "-") + ".json"), JSON.stringify(list));
  counts[t] = list.length;
}
fs.writeFileSync(path.join(OUT, "stores.json"), JSON.stringify({ updated: new Date().toISOString(), stores, counts, report }, null, 1));
console.log("counts", counts);
