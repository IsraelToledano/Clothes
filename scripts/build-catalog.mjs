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
  { d: "portugueseflannel.com", name: "Portuguese Flannel", tags: ["relaxed", "classic", "minimal"], def: "Shirts" }, // a shirt maker: untyped pieces are shirts
  { d: "oliverspencer.co.uk", name: "Oliver Spencer", tags: ["smart", "minimal", "relaxed"] },
  { d: "universalworks.co.uk", name: "Universal Works", tags: ["workwear", "relaxed", "vintage"] },
  { d: "kith.com", name: "Kith", tags: ["streetwear", "youthful", "preppy"] },
  { d: "corridornyc.com", name: "Corridor", tags: ["relaxed", "smart", "vintage"] },
  { d: "outerknown.com", name: "Outerknown", tags: ["relaxed", "surf", "minimal"] },
  { d: "howlerbros.com", name: "Howler Brothers", tags: ["surf", "relaxed", "sporty"] },
  { d: "ledbury.com", name: "Ledbury", tags: ["smart", "tailored", "classic"] },
  { d: "knickerbocker.nyc", name: "Knickerbocker", tags: ["vintage", "workwear", "classic"] },
  { d: "ironandresin.com", name: "Iron & Resin", tags: ["workwear", "vintage", "rugged"] },
  // Added in 1.3 for briefs like "Ralph Lauren, Club Monaco, J.Crew" (all ship to Israel, checked with the store probe).
  { d: "clubmonaco.com", name: "Club Monaco", tags: ["smart", "minimal", "classic", "tailored"], path: "/collections/mens" }, // its full list is mostly women's and old pieces
  { d: "jpressonline.com", name: "J.Press", tags: ["preppy", "classic", "tailored", "vintage"] },
  { d: "grayers.com", name: "Grayers", tags: ["preppy", "classic", "relaxed"] },
  { d: "kamakurashirts.com", name: "Kamakura Shirts", tags: ["classic", "smart", "tailored"] },
  { d: "sunspel.com", name: "Sunspel", tags: ["minimal", "classic", "luxe"] },
  { d: "privatewhitevc.com", name: "Private White V.C.", tags: ["smart", "luxe", "rugged"] },
  { d: "colhays.com", name: "Colhay's", tags: ["luxe", "classic", "minimal"] },
  // Added in 1.6 (store probe of 55 candidates: these read and ship to Israel).
  { d: "norseprojects.com", name: "Norse Projects", tags: ["minimal", "smart", "relaxed"] },
  { d: "billyreid.com", name: "Billy Reid", tags: ["classic", "preppy", "relaxed"] },
  { d: "orlebarbrown.com", name: "Orlebar Brown", tags: ["luxe", "smart", "relaxed"] },
  { d: "debonnefacture.fr", name: "De Bonne Facture", tags: ["minimal", "luxe", "workwear"] },
  { d: "akindofguise.com", name: "A Kind of Guise", tags: ["relaxed", "vintage", "minimal"] },
  { d: "albamclothing.com", name: "Albam", tags: ["minimal", "workwear", "relaxed"] },
  { d: "folkclothing.com", name: "Folk", tags: ["minimal", "relaxed"] },
  { d: "waxlondon.com", name: "Wax London", tags: ["relaxed", "workwear", "vintage"] },
  { d: "youmustcreate.com", name: "YMC", tags: ["relaxed", "vintage", "minimal"] },
  { d: "kestin.co", name: "Kestin", tags: ["minimal", "workwear", "classic"] },
  { d: "mackweldon.com", name: "Mack Weldon", tags: ["sporty", "minimal"] },
  { d: "reigningchamp.com", name: "Reigning Champ", tags: ["sporty", "minimal", "streetwear"] },
  { d: "rancourtandcompany.com", name: "Rancourt & Co.", tags: ["classic", "preppy", "workwear"] },
  { d: "quoddy.com", name: "Quoddy", tags: ["classic", "workwear", "rugged"] },
  { d: "paulevansny.com", name: "Paul Evans", tags: ["classic", "smart", "tailored"] },
  { d: "thursdayboots.com", name: "Thursday Boots", tags: ["rugged", "workwear", "classic"] },
  { d: "armorlux.com", name: "Armor-Lux", tags: ["classic", "relaxed", "vintage"] },
  { d: "uskees.com", name: "Uskees", tags: ["workwear", "relaxed", "vintage"] },
  { d: "stoffa.co", name: "Stoffa", tags: ["luxe", "minimal", "tailored"] },
];

const NOT_HIS = /\b(femme|wmn'?s|wmns|nike (ps|gs|td)|jordan (ps|gs|td)|little kids?|big kids?|women|womens|women's|women’s|woman|ladies|girls?|kids?|boys?|baby(?![\s-]*(cashmere|alpaca|merino|cord))|toddler|skirts?|blouses?|bralettes?|bikinis?|leggings?|camisoles?|bodysuits?|jumpsuits?|rompers?|maternity|corsets?|bras?|halter|crop tops?|scarf tank|wrap top)\b/i;
// "Dress" is a women's piece only in the title or type, and not as in dress shirt, dress trouser or dress socks.
const A_DRESS = /\bdress(es)?\b(?!\s*(shirts?|trousers?|pants?|socks?|shoes?|boots?|chinos?|code|gordon))/i;
// Not clothes (or not one piece of clothing). Careful with colours and details: "Cream Oxford", "Floral Print
// Shirt", "Patch Pocket" and "Tie-Dye" are clothes (before 1.3 those words dropped them).
const NOT_CLOTHES = /\b(accessor(y|ies)|underwear|boxers?|boxer briefs?|briefs|pyjamas?|pajamas?|robes?|bow ?ties?|neckties?|ties?(?![- ]?dye)|socks?|hats?|caps?|beanies?|scarf|scarves|belts?|bags?|totes?|backpacks?|wallets?|card ?holders?|gloves?|sunglasses|glasses|jewel(le)?ry|bracelets?|necklaces?|rings?|cufflinks?|pocket squares?|bandanas?|keyrings?|watch(es)?|watch straps?|laces|shoe care|shoe cream|polish|shoe brush|hangers?|face ?masks?|face covering|gift ?cards?|e-?gift|candles?|mugs?|posters?|stickers?|books?|magazines?|keychains?|key rings?|umbrellas?|towels?|blankets?|fragrances?|perfumes?|cologne|incense|art prints?|enamel pins?|lapel pins?|patches|swatch(es)?|fabric samples?|samples?|bundles?|insurance|shipping|donations?|cushions?|pillows?|rugs?|ornaments?|playing cards|dog|leash|collar for|mtm|made to measure|spacer|wine|resoles?|refurbishment|insoles?|footbeds?|protection|lunchbox|washbags?|notebooks?|glass(es)? set|undershirts?|cummerbunds?|braces|eyewear|earrings?|ear cuffs?|snapbacks?|strapbacks?|hair|styling paste|publications?|print material|gicl[ée]e|helmets?|sacoches?|pouch(es)?|plates?|masks?)\b/i;
const SKU_TITLE = /^[A-Z]{1,2}\d{3}[A-Z0-9]{3,}\b/; // "M993C0370Q - Original Fabrics": a fabric for made-to-measure, not a piece

// The app's types. First match wins, so the more specific ones come first.
const TYPE_RULES = [
  ["Shoes", /\b(footwear|sneakers?|trainers?|shoes?|boots?|loafers?|sandals?|derbys?|derbies|moccasins?|mules?|slides|espadrilles?|clogs?|slippers?|oxfords? (shoes?|sneakers?)|tennis oxfords?)\b/i],
  ["Shorts", /\b(bermudas?|sweatshorts?|shorts|short)\b(?!\s*-?\s*sleeve)|\bswim ?trunks?\b|\bboardshorts?\b/i],
  ["Trousers", /\b(pantalons?|pants?|trousers?|chinos?|jeans?|denim pant|slacks|joggers?|sweatpants?|overalls|5 pockets?|five pockets?)\b/i],
  ["Overshirts", /\b(overshirts?|over-shirts?|shirt jackets?|shirt-jackets?|shackets?|chore (coats?|jackets?)|cpo)\b/i],
  ["Jackets", /\b(doudounes?|vestes?|manteaux?|cabans?|blousons?|cirés?|puffers?|topcoats?|raincoats?|trench(coats?)?|balmacaans?|chesterfields?|sherpas?|truckers?|jackets?|blazers?|coats?|parkas?|bombers?|anoraks?|gilets?|vests?|waistcoats?|cagoules?|windbreakers?|sport ?coats?|overcoats?|peacoats?|suits?|suit outfit|tuxedos?(?! shirt))\b/i],
  ["T-shirts", /\b(d[ée]bardeurs?|longsleeves?|marini[eè]res?|tee-shirts?|t-?shirts?|tees?|henleys?|ringer|tank tops?|thermals?)\b/i],
  ["Knitwear", /\b(pulls?|pull-overs?|knitwear|sweatshirts?|hoodies?|hooded|loopback|lambswool|roll ?necks?|rollnecks?|sweaters?|cardigans?|jumpers?|knits?|knitted|crewnecks?|quarter[- ]zip|half[- ]zip|turtlenecks?|mock ?necks?|pullovers?|cashmere|merino|fair isle|cable)\b/i],
  ["Shirts", /\b(button[- ]ups?|chemises?|wovens?|spread|shirts?|oxfords?|popovers?|button[- ]downs?|polos?|rugbys?|camp collar|flannels?|chambray|overshirts?)\b/i],
];
function typeOf(p) {
  const hay = [p.title, p.product_type].join(" ");
  // A broad store type ("Men-Shirts & Tops") says less than the title ("Ribbed Slub Tee").
  if (/&|\/|\btops?\b/i.test(p.product_type || "")) for (const [t, re] of TYPE_RULES) if (re.test(p.title || "")) return t;
  for (const [t, re] of TYPE_RULES) if (re.test(p.product_type || "") ) return t;
  for (const [t, re] of TYPE_RULES) if (re.test(hay)) return t;
  if (/outerwear/i.test(p.product_type || "")) return "Jackets"; // only when the title didn't say (an "Outerwear" overshirt is an overshirt)
  return "";
}
const FABRICS = ["oxford", "poplin", "linen", "seersucker", "chambray", "denim", "flannel", "madras", "gingham", "corduroy", "twill", "jersey", "pique", "terry", "cashmere", "merino", "wool", "silk", "suede", "leather", "canvas", "cotton", "fleece", "nylon", "herringbone", "tweed", "mohair", "boucle", "waffle", "velvet"];
const COLOURS = ["navy", "light blue", "sky blue", "blue", "white", "ecru", "cream", "ivory", "bone", "oatmeal", "oat", "sand", "stone", "khaki", "tan", "camel", "brown", "chocolate", "olive", "forest", "green", "sage", "mint", "teal", "grey", "gray", "charcoal", "black", "red", "burgundy", "wine", "pink", "rose", "coral", "orange", "rust", "yellow", "mustard", "gold", "purple", "lavender", "indigo"];
const findWord = (list, s) => { const t = String(s).toLowerCase(); for (const w of list) if (new RegExp("\\b" + w + "\\b").test(t)) return w; return ""; };
const cap = (s) => (s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : "");
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const MAX_IMG = 8, CORE_IMG = 3, DETAIL_CHUNKS = 128;
// A store's photo address without the size (the app asks for the size it needs).
const imgUrl = (u) => { u = String(u || ""); if (u.startsWith("//")) u = "https:" + u; return u.replace(/([?&])width=\d+&?/, "$1").replace(/[?&]$/, ""); };
// The folder most of a store's photos live in; each photo is saved without it (it's in stores.json once).
function prefixOf(urls){
  const c = {}; let best = "", n = 0;
  for (const u of urls){ const i = u.lastIndexOf("/"); if (i > 8){ const p = u.slice(0, i + 1); c[p] = (c[p] || 0) + 1; if (c[p] > n){ n = c[p]; best = p; } } }
  return best;
}
// The store's description as plain text: bullet points kept, markup and boilerplate dropped.
const ENT = {amp:"&", nbsp:" ", quot:'"', apos:"'", lt:"<", gt:">", rsquo:"’", lsquo:"‘", rdquo:"”", ldquo:"“", ndash:"–", mdash:"—", hellip:"…", deg:"°", reg:"®", trade:"™", copy:"©", eacute:"é", egrave:"è", times:"×", frac12:"½", bull:"•", middot:"·"};
function textOf(html){
  let s = String(html || "");
  s = s.replace(/<(script|style|table|iframe)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<li[^>]*>/gi, "\n• ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h\d|li|ul|ol|tr|section)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&(#x?[0-9a-f]+|[a-z]+\d*);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENT[e.toLowerCase()] ?? m));
  const lines = s.split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim()).filter((l) => l && l !== "•" && !/^(free shipping|free returns|shipping|returns?|size guide|model is|click here|see size|need help)/i.test(l.replace(/^•\s*/, "")));
  let out = "";
  for (const l of lines){ if ((out + "\n" + l).length > 1200) break; out += (out ? "\n" : "") + l; }
  if (!out && lines.length) out = lines[0].slice(0, 1200);
  return out;
}
// The same hash as the app's hashStr: which details file a piece's details are in.
const hashStr = (x) => { let h = 2166136261; for (const c of String(x)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
// How a piece is cut, in the store's own words: long (knee length, mid-thigh, longline, overcoats) or cropped;
// oversized/boxy/wide or slim/trim. The app uses it with your height and build ("About you").
const CUT_LONG = /\b(knee[- ]length|below the knee|to the knee|mid[- ]thigh|longline|long[- ]line|longer length|long length|full[- ]length|ankle[- ]length|maxi|duster|overcoat|topcoat|great ?coat|chesterfield|trench ?coat|balmacaan)\b/i;
const CUT_CROP = /\b(cropped|waist[- ]length|hip[- ]length|hits at the (hip|waist)|shorter length|short length|shorter body)\b/i;
const CUT_BIG = /\b(oversized|over-sized|boxy|roomy|generous fit|loose fit|loose-fitting|wide[- ]leg|wide fit|baggy|dropped shoulders?|drop[- ]shoulders?)\b/i;
const CUT_TRIM = /\b(slim fit|slim-fit|trim fit|slim cut|tapered|close[- ]fitting|tailored fit|skinny)\b/i;
function cutOf(text){
  let c = "";
  if (CUT_LONG.test(text)) c += "L"; else if (CUT_CROP.test(text)) c += "C";
  if (CUT_BIG.test(text)) c += "O"; else if (CUT_TRIM.test(text)) c += "T";
  return c;
}
// Shorts: the inseam in inches ('5" inseam', '7-inch', 'Inseam: 9"').
function inseamOf(text){
  const m = /(\d{1,2}(?:\.\d)?)\s?(?:"|”|''|-inch|\s?inch(?:es)?)(?=[^a-z]|$)/i.exec(text) || /inseam[^.\d]{0,24}(\d{1,2}(?:\.\d)?)/i.exec(text);
  const n = m ? parseFloat(m[1]) : 0;
  return n >= 3 && n <= 13 ? n : 0;
}
const tagValue = (tags, re) => { for (const t of tags){ const m = re.exec(t); if (m) return clean(m[1]); } return ""; };

async function getJSON(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(25000) }).catch((e) => ({ ok: false, status: String(e.message || e) }));
    if (r.ok) { try { return await r.json(); } catch (e) { return null; } }
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    throw new Error("HTTP " + r.status);
  }
  throw new Error("gave up after retries");
}

const byType = {}, report = [], details = Array.from({ length: DETAIL_CHUNKS }, () => ({}));
for (const [si, s] of STORES.entries()) {
  const t0 = Date.now(), rep = { store: s.d, pages: 0, raw: 0, kept: 0, drop: { notHis: 0, notClothes: 0, soldOut: 0, noPhoto: 0, noType: 0 }, samples: { notHis: [], noType: [] } }, mine = [];
  const drop = (why, title) => { rep.drop[why]++; if (rep.samples[why] && rep.samples[why].length < 5) rep.samples[why].push(title); };
  try {
    const meta = await getJSON(`https://${s.d}/meta.json`).catch(() => null);
    s.cur = (meta && meta.currency) || "USD";
    s.il = meta && Array.isArray(meta.ships_to_countries) ? meta.ships_to_countries.includes("IL") : null;
    for (let page = 1; page <= 12; page++) {
      const j = await getJSON(`https://${s.d}${s.path || ""}/products.json?limit=250&page=${page}`);
      const list = (j && j.products) || [];
      rep.pages = page; rep.raw += list.length;
      for (const p of list) {
        const title = clean(p.title), ptype = clean(p.product_type), tags = (Array.isArray(p.tags) ? p.tags : String(p.tags || "").split(",")).map((x) => clean(x).toLowerCase()).filter(Boolean);
        const hay = [title, ptype, tags.join(" ")].join(" ");
        if (NOT_HIS.test(hay) || A_DRESS.test(title + " " + ptype)) { drop("notHis", title + " [" + ptype + "] <" + (NOT_HIS.exec(hay) || A_DRESS.exec(title + " " + ptype))[0] + ">"); continue; }
        if (NOT_CLOTHES.test(title + " " + ptype) || SKU_TITLE.test(title)) { drop("notClothes", title); continue; }
        const all = p.variants || [], variants = all.filter((v) => v.available !== false);
        if (!variants.length) { drop("soldOut", title); continue; }
        const imgs = [...new Set((p.images || []).map((im) => im && im.src).filter(Boolean).map(imgUrl))];
        if (!imgs.length) { drop("noPhoto", title); continue; }
        const type = typeOf({ title, product_type: ptype }) || s.def || "";
        if (!type) { drop("noType", title + " [" + ptype + "]"); continue; }
        // The cheapest piece in stock, and its full price when it's on sale.
        const cheap = variants.reduce((a, v) => ((Number(v.price) || Infinity) < (Number(a.price) || Infinity) ? v : a), variants[0]);
        const price = Number(cheap.price) || 0, was = Number(cheap.compare_at_price) || 0;
        // Options: sizes (in stock and sold out), colours and the rest.
        const opts = (p.options || []).map((o, k) => ({ name: clean(o.name || o), k, values: (Array.isArray(o.values) ? o.values : []).map(clean).filter(Boolean) }));
        const sizeOpt = opts.find((o) => /^(size|waist|shoe size|us size|uk size|eu size)\b/i.test(o.name)) || opts.find((o) => /size/i.test(o.name));
        const colourOpt = opts.find((o) => /colou?r/i.test(o.name));
        const vo = (v, o) => clean(v["option" + (o.k + 1)]);
        let sizes, soldOut = [];
        if (sizeOpt){
          const inStock = new Set(variants.map((v) => vo(v, sizeOpt)));
          const order = sizeOpt.values.length ? sizeOpt.values : [...inStock];
          sizes = order.filter((x) => inStock.has(x));
          soldOut = order.filter((x) => !inStock.has(x));
        } else sizes = [...new Set(variants.map((v) => clean(v.option1 || v.title)).filter((x) => x && x.length <= 6 && !/default/i.test(x)))];
        // The colour: a single colour option, a "color: x" tag, the end of the title ("... - Military Green"), or a colour word in it.
        const tail = /\s[-–:|]\s([^-–:|]+)$/.exec(title);
        const colour = (colourOpt && colourOpt.values.length === 1 && colourOpt.values[0]) || tagValue(tags, /^colou?r\s*[:_-]\s*(.+)$/) || findWord(COLOURS, tail ? tail[1] : "") || findWord(COLOURS, title + " " + (variants[0].title || ""));
        const fit = tagValue(tags, /^fit\s*[:_-]\s*(.+)$/);
        const id = "p-" + s.d.split(".")[0] + "-" + p.id;
        const item = {
          id, s: si, t: title, pt: ptype,
          h: p.handle, p: price,
          im: imgs.slice(0, CORE_IMG), // the first photos; the rest (up to 8) are in the details file
          ...(imgs.length > CORE_IMG ? { pn: Math.min(MAX_IMG, imgs.length) } : {}),
          c: cap(colour.length <= 24 ? colour : ""), f: cap(findWord(FABRICS, title + " " + ptype + " " + tags.join(" "))),
          tg: tags.filter((x) => x.length <= 24 && !/^(sale|new|yotpo|size|_|filter|price|gid:)/.test(x)).slice(0, 12),
          sz: sizes.slice(0, 16), d: String(p.published_at || p.created_at || "").slice(0, 10),
        };
        if (was > price) item.cp = was;
        const descText = textOf(p.body_html);
        const cut = cutOf([title, tags.join(" "), descText].join(" "));
        if (cut) item.ct = cut;
        if (type === "Shorts"){ const ins = inseamOf(title) || inseamOf(descText); if (ins) item.is = ins; }
        if (fit && fit.length <= 20) item.ft = cap(fit);
        (byType[type] = byType[type] || []).push(item);
        mine.push(item);
        // The longer details (opened from a card) go in small files the app loads only when you open one.
        const more = { d: descText };
        if (imgs.length > CORE_IMG) more.mi = imgs.slice(CORE_IMG, MAX_IMG);
        const other = opts.filter((o) => o !== sizeOpt && o.values.length > 1 && !/^title$/i.test(o.name)).map((o) => [o.name, o.values.slice(0, 12)]);
        if (other.length) more.o = other;
        if (soldOut.length) more.so = soldOut.slice(0, 16);
        if (p.vendor && clean(p.vendor).toLowerCase() !== s.name.toLowerCase() && !/\.(com|co|nyc)/i.test(p.vendor)) more.v = clean(p.vendor);
        details[hashStr(id) % DETAIL_CHUNKS][id] = more;
        rep.kept++;
      }
      if (list.length < 250) break;
      await sleep(800);
    }
  } catch (e) { rep.error = String(e.message || e); }
  // Save each photo without the store's common folder.
  s.ip = prefixOf(mine.flatMap((x) => x.im));
  if (s.ip) for (const x of mine) x.im = x.im.map((u) => (u.startsWith(s.ip) ? u.slice(s.ip.length) : u));
  if (s.ip) for (const x of mine){ const m = details[hashStr(x.id) % DETAIL_CHUNKS][x.id]; if (m && m.mi) m.mi = m.mi.map((u) => (u.startsWith(s.ip) ? u.slice(s.ip.length) : u)); }
  rep.ms = Date.now() - t0;
  report.push(rep);
  console.log(JSON.stringify(rep));
}

const stores = STORES.map((s) => ({ d: s.d, name: s.name, tags: s.tags, cur: s.cur || "USD", il: s.il, ip: s.ip || "" }));
const counts = {};
for (const [t, list] of Object.entries(byType)) {
  // newest first within each store keeps the catalog fresh-looking
  list.sort((a, b) => (b.d || "").localeCompare(a.d || ""));
  fs.writeFileSync(path.join(OUT, t.toLowerCase().replace(/[^a-z]+/g, "-") + ".json"), JSON.stringify(list));
  counts[t] = list.length;
}
fs.mkdirSync(path.join(OUT, "details"), { recursive: true });
details.forEach((d, n) => fs.writeFileSync(path.join(OUT, "details", String(n).padStart(3, "0") + ".json"), JSON.stringify(d)));
// format 2: photos relative to each store's "ip"; the first 3 in the type file ("pn" = how many in all), photos
// 4-8 ("mi") and the longer details in details/NNN.json (hashStr(id) mod 128)
fs.writeFileSync(path.join(OUT, "stores.json"), JSON.stringify({ updated: new Date().toISOString(), format: 2, chunks: DETAIL_CHUNKS, stores, counts, report }, null, 1));
console.log("counts", counts);
