// Which online stores can Drape search for real products, for free and without keys?
// Shopify stores answer a public product search at /search/suggest.json (the same one their own
// search box uses). Run by .github/workflows/store-probe.yml; results go to the "live-results" branch.
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("results");
fs.mkdirSync(OUT, { recursive: true });
const STORES = (process.env.STORES || [
  "rowingblazers.com", "alexmill.com", "toddsnyder.com", "buckmason.com", "taylorstitch.com", "aimeleondore.com",
  "drakes.com", "faherty.com", "percivalclo.com", "oliverspencer.co.uk", "universalworks.co.uk", "portugueseflannel.com",
  "unionmadegoods.com", "kith.com", "sidmashburn.com", "spierandmackay.com", "lucafaloni.com", "ledbury.com",
  "brooksbrothers.com", "gant.com", "eu.gant.com", "jcrew.com", "ralphlauren.com", "abercrombie.com", "bonobos.com",
  "outerknown.com", "marine-layer.com", "vuori.com", "manresa.co", "theshirtstore.co", "noahny.com", "beamsplus.com",
  "corridornyc.com", "knickerbocker.nyc", "freenote.com", "ironandresin.com", "howlerbros.com", "tuckernuck.com",
].join(",")).split(",");
const Q = process.env.Q || "oxford shirt";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1";

async function probe(store) {
  const t0 = Date.now(), r = { store };
  try {
    const u = `https://${store}/search/suggest.json?q=${encodeURIComponent(Q)}&resources[type]=product&resources[limit]=10`;
    const res = await fetch(u, { headers: { "User-Agent": UA, Accept: "application/json", Origin: "https://israeltoledano.github.io" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
    r.status = res.status; r.ms = Date.now() - t0; r.finalUrl = res.url;
    r.cors = res.headers.get("access-control-allow-origin");
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (e) { r.notJson = text.slice(0, 120).replace(/\s+/g, " "); }
    const prods = (j && j.resources && j.resources.results && j.resources.results.products) || [];
    r.count = prods.length;
    r.sample = prods.slice(0, 4).map((p) => ({ title: p.title, price: p.price, vendor: p.vendor, url: p.url, image: p.image || (p.featured_image && p.featured_image.url) }));
    const img = r.sample[0] && r.sample[0].image;
    if (img) {
      const ir = await fetch(img.startsWith("//") ? "https:" + img : img, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      const buf = Buffer.from(await ir.arrayBuffer());
      r.image = { status: ir.status, bytes: buf.length, type: ir.headers.get("content-type") };
      if (ir.ok) fs.writeFileSync(path.join(OUT, "store-" + store.replace(/[^a-z0-9]/gi, "_") + ".jpg"), buf);
    }
    // Currency / ships to Israel hints from the store's own settings
    const meta = await fetch(`https://${store}/meta.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (meta) r.meta = { name: meta.name, currency: meta.currency, country: meta.country, ships_to_countries: Array.isArray(meta.ships_to_countries) ? meta.ships_to_countries.includes("IL") : undefined };
  } catch (e) { r.error = String((e && e.message) || e); r.ms = Date.now() - t0; }
  return r;
}

// MODE=catalog: can the daily catalog read the store (public /products.json), and does it ship to Israel?
async function probeCatalog(store) {
  const t0 = Date.now(), r = { store };
  try {
    const res = await fetch(`https://${store}/products.json?limit=250&page=1`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; DrapeCatalog/1.0; personal menswear app; +https://israeltoledano.github.io/Clothes/)", Accept: "application/json" }, redirect: "follow", signal: AbortSignal.timeout(20000) });
    r.status = res.status; r.ms = Date.now() - t0; r.finalUrl = res.url;
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (e) { r.notJson = text.slice(0, 100).replace(/\s+/g, " "); }
    const prods = (j && j.products) || [];
    r.count = prods.length;
    const mens = prods.filter((p) => !/women|womens|ladies|girls|kids/i.test([p.title, p.product_type, (p.tags || []).join(" ")].join(" ")));
    r.mens = mens.length;
    r.types = [...new Set(mens.map((p) => p.product_type).filter(Boolean))].slice(0, 12);
    r.sample = mens.slice(0, 5).map((p) => p.title + " $" + ((p.variants || [])[0] || {}).price + " " + ((p.images || []).length) + " photos");
    const meta = await fetch(`https://${store}/meta.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (meta) r.meta = { name: meta.name, currency: meta.currency, il: Array.isArray(meta.ships_to_countries) ? meta.ships_to_countries.includes("IL") : null };
    // Pieces the list calls sold out: does the store's own product page agree?
    const out = mens.filter((p) => (p.variants || []).every((v) => v.available === false));
    r.soldOutInList = out.length;
    r.soldOutCheck = [];
    const host = store.split("/")[0];
    for (const p of out.slice(0, 6)) {
      const j2 = await fetch(`https://${host}/products/${p.handle}.js`, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) }).then((x) => (x.ok ? x.json() : { status: x.status })).catch((e) => ({ error: String(e) }));
      r.soldOutCheck.push(p.title + ": page says available=" + j2.available + " (" + ((j2.variants || []).filter((v) => v.available).length) + "/" + ((j2.variants || []).length) + " sizes)" + (j2.status ? " HTTP " + j2.status : ""));
    }
  } catch (e) { r.error = String((e && e.message) || e); r.ms = Date.now() - t0; }
  return r;
}
if (process.env.MODE === "catalog") {
  const results = await Promise.all(STORES.map(probeCatalog));
  fs.writeFileSync(path.join(OUT, "catalog-probe.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  const md = [`# Catalog probe — ${new Date().toISOString()}`, ""].concat(results.map((r) => `- ${r.store}: ${r.error ? "ERROR " + r.error : r.status + " " + r.ms + "ms, " + (r.count || 0) + " products (" + (r.mens || 0) + " not women's)" + (r.notJson ? " NOT JSON: " + r.notJson : "")}${r.meta ? " — " + r.meta.name + ", " + r.meta.currency + ", ships to IL: " + r.meta.il : ""}${r.types && r.types.length ? " — types: " + r.types.join(", ") : ""}${r.sample && r.sample.length ? " — e.g. " + r.sample.join(" | ") : ""}${r.soldOutInList ? " — sold out in the list: " + r.soldOutInList + "; " + r.soldOutCheck.join("; ") : ""}`));
  fs.writeFileSync(path.join(OUT, "catalog-probe.md"), md.join("\n"));
  console.log(md.join("\n"));
  process.exit(0);
}
const results = await Promise.all(STORES.map(probe));
fs.writeFileSync(path.join(OUT, "store-probe.json"), JSON.stringify({ at: new Date().toISOString(), q: Q, results }, null, 2));
const md = [`# Store probe — ${new Date().toISOString()} — "${Q}"`, ""].concat(results.map((r) =>
  `- ${r.store}: ${r.error ? "ERROR " + r.error : r.status + " in " + r.ms + "ms, " + (r.count || 0) + " products"}${r.notJson ? " (not JSON: " + r.notJson + ")" : ""}${r.image ? ", image " + r.image.status + " " + r.image.bytes + "B" : ""}${", CORS " + (r.cors || "none")}${r.meta ? ", " + r.meta.currency + (r.meta.ships_to_countries === true ? ", ships to IL" : r.meta.ships_to_countries === false ? ", NOT to IL" : "") : ""}${r.sample && r.sample[0] ? " — e.g. " + r.sample[0].title + " (" + r.sample[0].price + ")" : ""}`
));
fs.writeFileSync(path.join(OUT, "store-probe.md"), md.join("\n"));
console.log(md.join("\n"));
