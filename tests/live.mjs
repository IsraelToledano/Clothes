// Live test for Drape: the real app (this checkout, served locally) against the real AI server.
// Run by .github/workflows/live-test.yml. Writes results/summary.json, summary.md, report.txt,
// screenshots and the AI photos, which the workflow saves to the "live-results" branch.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const WORKER = process.env.WORKER || "https://clothes.srul7022.workers.dev";
const OUT = path.resolve("results");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const R = { started: new Date().toISOString(), worker: WORKER, log: [] };
const log = (...a) => { const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(line); R.log.push(line); };
const save = () => fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(R, null, 2));
const BRIEF = { type: "Shirts", styles: ["Smart-casual"], text: "Ralph Lauren, Club Monaco and J.Crew style" };

// A short-lived GitHub token for this repo; the worker accepts it in place of the access code.
async function token() {
  if (process.env.TEST_CODE) return process.env.TEST_CODE; // local dry run against the mock server
  const r = await fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=drape-live-test", { headers: { Authorization: "Bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } });
  return (await r.json()).value;
}
async function timed(fn) {
  const t = Date.now();
  try { return { ok: true, ms: Date.now() - t, ...(await fn()), ms: Date.now() - t }; }
  catch (e) { return { ok: false, ms: Date.now() - t, error: String((e && e.message) || e) }; }
}

try {
  /* ---------- 0. the deployed server is the one in this commit ---------- */
  const expected = /SERVER_VERSION = "([^"]+)"/.exec(fs.readFileSync("worker/worker.js", "utf8"))[1];
  R.expectedServer = expected;
  for (let i = 0; i < 40; i++) {
    const r = await fetch(WORKER + "/").then((x) => x.json()).catch((e) => ({ error: String(e) }));
    R.deployed = r.version || r.error;
    if (r.version === expected) break;
    log("waiting for Cloudflare to deploy", expected, "- now:", R.deployed);
    await sleep(15000);
  }
  log("server version", R.deployed, R.deployed === expected ? "(as expected)" : "(NOT the expected " + expected + ")");

  /* ---------- 1. the API directly ---------- */
  let tok = await token();
  R.health = await timed(async () => { const r = await fetch(WORKER + "/health?code=" + encodeURIComponent(tok)); return { status: r.status, body: await r.json() }; });
  log("health", R.health);
  // The catalog (built daily from the stores) and the AI's reading of the brief.
  const cat = JSON.parse(fs.readFileSync("catalog/stores.json", "utf8"));
  R.catalog = { updated: cat.updated, counts: cat.counts, failedStores: cat.report.filter((r) => r.error).map((r) => r.store + ": " + r.error) };
  const shirts = JSON.parse(fs.readFileSync("catalog/shirts.json", "utf8"));
  // Format 2 saves photos without the store's folder ("ip") and without a size; the app asks for one.
  const photo = (x, k, w) => { const st = cat.stores[x.s]; let u = x.im[k]; if (!/^https?:/.test(u)) u = (st.ip || "") + u; u = u.replace(/([?&])width=\d+&?/, "$1").replace(/[?&]$/, ""); return u + (u.includes("?") ? "&" : "?") + "width=" + w; };
  const nPh = shirts.map((x) => x.im.length).sort((a, b) => a - b);
  R.catalog.format = cat.format || 1;
  R.catalog.photosPerShirt = { median: nPh[Math.floor(nPh.length / 2)], min: nPh[0], max: nPh[nPh.length - 1], oneOnly: nPh.filter((n) => n === 1).length, of: nPh.length };
  if (cat.format === 2) {
    const files = fs.readdirSync("catalog/details"), det = {};
    for (const f of files) Object.assign(det, JSON.parse(fs.readFileSync(path.join("catalog/details", f), "utf8")));
    R.catalog.details = { files: files.length, pieces: Object.keys(det).length, withDescription: Object.values(det).filter((d) => d.d).length, withSoldOutSizes: Object.values(det).filter((d) => d.so).length, onSale: shirts.filter((x) => x.cp).length + " shirts" };
  }
  R.photosApi = [];
  for (const [n, x] of shirts.filter((_, k) => k % Math.floor(shirts.length / 6) === 0).slice(0, 6).entries()) {
    for (const [k, w] of [[0, 900], [Math.min(1, x.im.length - 1), 2000]]) {
      const res = await timed(async () => { const r = await fetch(photo(x, k, w)); const buf = Buffer.from(await r.arrayBuffer()); if (r.ok) fs.writeFileSync(path.join(OUT, `catalog-photo-${n + 1}${w === 2000 ? "-big" : ""}.jpg`), buf); return { status: r.status, bytes: buf.length }; });
      R.photosApi.push({ title: x.t, store: cat.stores[x.s].name, width: w, ...res });
    }
  }
  R.keywordsApi = await timed(async () => {
    const r = await fetch(WORKER + "/keywords", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ code: tok, query: BRIEF }) });
    return { status: r.status, body: await r.json() };
  });
  log("keywords (API)", R.keywordsApi);
  save();

  /* ---------- 2. the real app, as on the phone ---------- */
  const TYPES = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".png": "image/png" };
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const p = path.join(process.cwd(), u === "/" ? "index.html" : u);
    fs.readFile(p, (err, data) => { if (err) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" }); res.end(data); });
  }).listen(+process.env.APP_PORT || 8000);

  const { chromium } = await import("playwright");
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Asia/Jerusalem" });
  const page = await ctx.newPage();
  // Local dry run only: stand-in photos when the stores' image server can't be reached.
  if (process.env.FAKE_PHOTOS) await page.route("https://cdn.shopify.com/**", (r) => r.fulfill({ status: 200, contentType: "image/jpeg", body: fs.readFileSync(process.env.FAKE_PHOTOS) }));
  R.app = { requests: [], errors: [], cards: [] };
  page.on("pageerror", (e) => R.app.errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") R.app.errors.push("console: " + m.text()); });
  const started = new Map();
  page.on("request", (q) => { if (q.url().startsWith(WORKER)) started.set(q, Date.now()); });
  page.on("requestfailed", (q) => { if (q.url().startsWith(WORKER)) R.app.requests.push({ kind: new URL(q.url()).pathname, failed: q.failure() && q.failure().errorText, ms: Date.now() - (started.get(q) || Date.now()) }); });
  page.on("response", async (r) => {
    if (!r.url().startsWith(WORKER)) return;
    const kind = new URL(r.url()).pathname, ms = Date.now() - (started.get(r.request()) || Date.now());
    const e = { kind, status: r.status(), ms, at: Date.now() };
    if ((kind === "/ideas" || kind === "/products" || kind === "/more")) { try { const j = await r.json(); e.model = j.model; e.serverMs = j.ms; e.count = (j.ideas || j.products || []).length; e.error = j.error; } catch (x) {} }
    if (kind === "/image") e.model = r.headers()["x-drape-image-model"];
    R.app.requests.push(e);
  });

  await page.goto("http://localhost:" + (+process.env.APP_PORT || 8000) + "/");
  await page.evaluate(([w, t, v, q]) => {
    localStorage.setItem("clothes:ai", JSON.stringify({ url: w, code: t, on: true, health: { ideas: true, images: true, version: v } }));
    localStorage.setItem("clothes:query", JSON.stringify(q));
  }, [WORKER, (tok = await token()), expected, BRIEF]);
  await page.reload();
  await page.waitForTimeout(800);
  await page.click('[data-act="go"]');
  const t0 = Date.now();
  let tokAt = Date.now();
  const first = await page.waitForSelector("#card", { timeout: 90000 }).then(() => true).catch(() => false);
  R.app.firstCardMs = first ? Date.now() - t0 : null;
  log("first card", first ? R.app.firstCardMs + "ms" : "NOT SHOWN in 90s");
  if (!first) {
    await page.screenshot({ path: path.join(OUT, "stuck.png") });
    R.app.stuck = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 600), aiErr: S.aiErr, fetching: !!S.fetching, queue: S.queue.length }));
  }

  // Swipe through cards: left = not now, right = getting closer (keys do the same as swipes).
  // Eight cards: enough to see speed, variety and a heart, without using much of the daily allowance.
  const plan = ["later", "like", "later", "later", "later", "like", "later", "later"];
  let swipedAt = null;
  for (let n = 0; first && n < plan.length; n++) {
    if (Date.now() - tokAt > 150000) { const t = await token(); await page.evaluate((x) => { AI.code = x; }, t); tokAt = Date.now(); }
    const shownAt = Date.now(), waitedMs = swipedAt ? shownAt - swipedAt : R.app.firstCardMs;
    const card = await page.evaluate(() => S.current && { id: S.current.id, title: S.current.title, why: S.current.why, colour: S.current.colour, fabric: S.current.fabric, store: S.current.store, brand: S.current.brand, price: S.current.price, currency: S.current.currency, url: S.current.url, boost: S.current._boost || 0 });
    const photo = await page.waitForSelector(".idea-img img.ok", { timeout: 40000 }).then(() => Date.now() - shownAt).catch(() => null);
    const imgErr = photo == null ? await page.evaluate(() => S.imgErr || (document.querySelector(".idea-img .ph") || {}).innerText || "") : undefined;
    await page.screenshot({ path: path.join(OUT, `card-${String(n + 1).padStart(2, "0")}.png`) });
    R.app.cards.push({ n: n + 1, ...card, waitedMs, photoMs: photo, photoError: imgErr, swipe: plan[n] });
    await page.waitForTimeout(1500); // a person looks at the card for a moment
    log("card", n + 1, card && card.title, "| photo", photo == null ? "FAILED " + imgErr : photo + "ms", "| swipe", plan[n]);
    const before = card && card.id;
    await page.keyboard.press(plan[n] === "like" ? "ArrowRight" : "ArrowLeft");
    swipedAt = Date.now();
    const next = await page.waitForFunction((id) => S.current && S.current.id !== id && document.getElementById("card"), before, { timeout: 90000 }).then(() => true).catch(() => false);
    if (!next) {
      await page.screenshot({ path: path.join(OUT, `stuck-after-${n + 1}.png`) });
      R.app.stuckAfter = { n: n + 1, ...(await page.evaluate(() => ({ text: document.body.innerText.slice(0, 600), aiErr: S.aiErr, fetching: !!S.fetching, queue: S.queue.length }))) };
      log("STUCK after card", n + 1, R.app.stuckAfter);
      break;
    }
    await page.waitForTimeout(300);
  }
  // The same piece (in any colour) never comes back in a search.
  R.app.samePiece = await page.evaluate(() => { const k = S.round.votes.map(seenKey), d = k.filter((x, j) => k.indexOf(x) !== j); return d; }).catch((e) => ["check failed: " + e.message]);
  /* ---------- 3. more photos, the details view, the full-screen photo, saved ---------- */
  if (first && !R.app.stuckAfter) {
    const g = (R.app.gallery = {});
    const votes0 = await page.evaluate(() => TASTE.votes.length), a0votes = () => votes0;
    try {
      await page.waitForSelector("#card img.prod.ok", { timeout: 20000 });
      g.card = await page.evaluate(() => ({ title: S.current.title, store: S.current.store, photos: photosOf(S.current).length }));
      const box = await page.locator("#card .idea-img").boundingBox();
      let t = Date.now();
      await page.touchscreen.tap(box.x + box.width * 0.8, box.y + box.height / 2);
      g.flipMs = await page.waitForFunction(() => { const i = document.querySelector("#card img.prod"); return curPh() === 1 && i && i.complete && i.naturalWidth > 0 && i.src === photoAt(S.current, 1, 900); }, null, { timeout: 15000 }).then(() => Date.now() - t).catch(() => null);
      g.tapVoted = await page.evaluate(() => TASTE.votes.length) !== a0votes();
      await page.screenshot({ path: path.join(OUT, "gallery-photo-2.png") });
      // The middle of the card's photo opens it full screen (sharp copy), on the same photo.
      t = Date.now();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.45);
      await page.waitForSelector("#zoom", { timeout: 5000 });
      g.cardZoom = { opened: true, photo: await page.evaluate(() => Z.k + 1) };
      await page.waitForTimeout(300);
      g.cardZoom.opensAt = await page.evaluate(() => ({ scale: +Z.sc.toFixed(2), fill: +(Z.def || 0).toFixed(2), shown: document.getElementById("zImg").style.opacity }));
      g.cardZoom.sharpMs = await page.waitForFunction(() => { const i = document.getElementById("zImg"); return i && /width=2000/.test(i.src) && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 }).then(() => Date.now() - t).catch(() => null);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, "card-zoom.png") });
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
      g.cardZoom.closed = await page.evaluate(() => !document.getElementById("zoom") && !!document.getElementById("card"));
      // In full screen: a double-tap goes closer.
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height * 0.45);
      await page.waitForSelector("#zoom", { timeout: 5000 }); await page.waitForTimeout(600);
      const zb = await page.locator("#zStage").boundingBox();
      await page.touchscreen.tap(zb.x + zb.width / 2, zb.y + zb.height * 0.4); await page.waitForTimeout(120);
      await page.touchscreen.tap(zb.x + zb.width / 2, zb.y + zb.height * 0.4); await page.waitForTimeout(700);
      g.zoomScale = await page.evaluate(() => +(Z.sc / (Z.def || 1)).toFixed(2));
      await page.screenshot({ path: path.join(OUT, "zoom-2-double-tap.png") });
      await page.keyboard.press("Escape"); await page.waitForTimeout(500);
      // The card's photo is clean; the name, price and the store's details are below it (scroll down).
      g.card.onPhoto = await page.evaluate(() => document.querySelectorAll("#card .tag, #card .card-zoom, #card .idea-body, #card .insight, #card .swipe-hint").length);
      g.card.layout = await page.evaluate(() => { const r = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().bottom) : null; }; return { photoBottom: r("#card"), titleBottom: r("#idea-t"), screen: innerHeight }; });
      t = Date.now();
      g.moreMs = await page.waitForFunction(() => S.more[S.current.id] !== undefined, null, { timeout: 10000 }).then(() => Date.now() - t).catch(() => null);
      await page.evaluate(() => scrollTo(0, document.body.scrollHeight)); await page.waitForTimeout(1000);
      g.details = await page.evaluate(() => ({ thumbs: document.querySelectorAll(".card-more .dt-thumb").length, desc: ((document.querySelector("#card-more-in .dt-desc") || {}).innerText || "").slice(0, 300), sizes: [...document.querySelectorAll("#card-more-in .sz")].map((x) => x.innerText + (x.classList.contains("out") ? " (sold out)" : "")), specs: [...document.querySelectorAll(".card-more .specs div")].map((x) => x.innerText.replace("\n", ": ")) }));
      await page.screenshot({ path: path.join(OUT, "card-scrolled.png") });
      await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, "card-clean.png") });
      // Back to the previous piece, then forward again.
      const before = await page.evaluate(() => ({ title: S.current.title, prev: S.round.votes[S.round.votes.length - 1].title }));
      await page.click('[data-act="prev"]'); await page.waitForTimeout(500);
      g.back = { was: before.title, nowShowing: await page.evaluate(() => S.current.title), expected: before.prev };
      g.back.ok = g.back.nowShowing === before.prev;
      await page.keyboard.press("ArrowLeft"); await page.waitForTimeout(600);
      g.back.thenNext = await page.evaluate(() => S.current.title);
      await page.click('[data-act="save"]'); await page.waitForTimeout(300);
      await page.click('header [data-act="saved"]'); await page.waitForTimeout(1500);
      g.saved = await page.evaluate(() => ({ screen: S.screen, cards: document.querySelectorAll(".sv-card").length, photos: [...document.querySelectorAll(".sv-card img")].filter((i) => i.complete && i.naturalWidth > 0).length }));
      await page.screenshot({ path: path.join(OUT, "saved.png") });
      await page.click('[data-act="saved-tab"][data-v="liked"]'); await page.waitForTimeout(1200);
      g.liked = await page.evaluate(() => ({ cards: [...document.querySelectorAll(".sv-card .sv-t")].map((e) => e.innerText), hearted: S.round.votes.filter((v) => v.v === "like").map((v) => v.title) }));
      await page.screenshot({ path: path.join(OUT, "liked.png") });
      await page.click('[data-act="saved-back"]'); await page.waitForTimeout(400);
    } catch (e) { g.error = String((e && e.message) || e); await page.screenshot({ path: path.join(OUT, "gallery-error.png") }).catch(() => {}); }
    log("gallery & details", g);
  }
  /* ---------- 4. shoes: many different shoes, not a few in several colours ---------- */
  if (first) {
    try {
      await page.evaluate(() => { Q.type = "Shoes"; Q.styles = []; Q.text = "Quiet luxury style"; save("query", Q); startRound(); });
      await page.waitForSelector("#card img.prod.ok", { timeout: 20000 }); await page.waitForTimeout(800);
      R.app.shoes = await page.evaluate(() => {
        const l = [S.current].concat(S.queue).slice(0, 20);
        const same = []; for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) if (sameFamily(l[a], l[b])) same.push(l[a].title + " ~ " + l[b].title);
        const kinds = {}, makers = {}; for (const i of l){ kinds[i.kind] = (kinds[i.kind] || 0) + 1; makers[makerOf(i)] = (makers[makerOf(i)] || 0) + 1; }
        return { cards: l.map((i) => i.store + " | " + i.kind + " | " + i.title), sameModel: same, kinds: Object.keys(kinds).length, topMaker: Object.entries(makers).sort((x, y) => y[1] - x[1])[0] };
      });
      await page.screenshot({ path: path.join(OUT, "shoes.png") });
      log("shoes", R.app.shoes);
    } catch (e) { R.app.shoes = { error: String((e && e.message) || e) }; }
  }
  /* ---------- 5. About you: short and slim, looking for jackets ---------- */
  if (first) {
    try {
      const run = async (me) => {
        await page.evaluate((m) => { PREFS.me = m; save("prefs", PREFS); Q.type = "Jackets"; Q.styles = []; Q.text = ""; save("query", Q); startRound(); }, me);
        await page.waitForSelector("#card", { timeout: 20000 }); await page.waitForTimeout(800);
        return page.evaluate(() => { const l = [S.current].concat(S.queue).slice(0, 20); return { long: l.filter((i) => (i.ct || "").includes("L") || LONGISH.test(i.title.toLowerCase())).length, suitYou: l.filter((i) => fitForMe(i).s > 0).length, first: l.slice(0, 6).map((i) => i.store + " | " + i.title + " | " + i.why) }; });
      };
      R.app.aboutYou = { notSet: await run({ height: "", build: "", fit: "" }), shortSlim: await run({ height: "short", build: "slim", fit: "" }) };
      await page.screenshot({ path: path.join(OUT, "about-you-jackets.png") });
      log("about you", R.app.aboutYou);
    } catch (e) { R.app.aboutYou = { error: String((e && e.message) || e) }; }
  }
  R.app.report = await page.evaluate(() => askSnapshot()).catch((e) => "report failed: " + e.message);
  fs.writeFileSync(path.join(OUT, "report.txt"), R.app.report);
  await page.screenshot({ path: path.join(OUT, "final.png") });
  await browser.close();
  server.close();
} catch (e) {
  R.crash = String((e && e.stack) || e);
  log("TEST CRASHED", R.crash);
}

/* ---------- summary ---------- */
const a = R.app || {}, reqs = a.requests || [];
const ideas = reqs.filter((r) => ["/ideas", "/products", "/more"].includes(r.kind)), imgs = reqs.filter((r) => r.kind === "/image");
const photoMs = (a.cards || []).map((c) => c.photoMs).filter((x) => x != null);
const md = [
  `# Drape live test — ${R.started}`,
  `Server: ${R.deployed} (expected ${R.expectedServer})`,
  `Catalog: ${JSON.stringify(R.catalog)}`,
  `Catalog photos: ${(R.photosApi || []).map((i) => i.store + " w" + i.width + " " + i.status + " " + i.ms + "ms " + i.bytes + "B").join(" | ")}`,
  `API keywords: ${JSON.stringify(R.keywordsApi)}`,
  `App first card: ${a.firstCardMs == null ? "NOT SHOWN" : a.firstCardMs + "ms"}`,
  `App searches: ${ideas.map((r) => r.kind + " " + (r.status || "fail") + " " + r.ms + "ms " + (r.count != null ? r.count + " items " : "") + (r.model || r.failed || r.error || "")).join(" | ")}`,
  `App photos: ${imgs.length} requests; ${imgs.filter((r) => r.status === 200).length} ok; models ${[...new Set(imgs.map((r) => r.model))].join(",")}; median card photo wait ${photoMs.length ? photoMs.sort((x, y) => x - y)[Math.floor(photoMs.length / 2)] + "ms" : "-"}`,
  `Cards (waited = from the previous swipe until the card was there; photo = until its photo was there):`, ...(a.cards || []).map((c) => `  ${c.n}. ${c.title} — ${c.brand || ""} at ${c.store || ""} ${c.price || ""} ${c.currency || ""} — why: ${c.why || ""} — waited ${c.waitedMs}ms — photo ${c.photoMs == null ? "FAILED " + c.photoError : c.photoMs + "ms"} — ${c.swipe}${c.boost === 10 ? " (heart variation)" : ""}`),
  `Same piece twice (any colour): ${a.samePiece && a.samePiece.length ? a.samePiece.join("; ") : "never"}`,
  `Cards that show what in your words they match: ${(a.cards || []).filter((c) => /^(Like |You asked|You named|From your words)/.test(c.why || "")).length} of ${(a.cards || []).length}`,
  `Gallery, details, zoom, saved: ${JSON.stringify(a.gallery || null)}`,
  `Shoes (first 20): ${a.shoes ? (a.shoes.error || a.shoes.kinds + " kinds; most from one maker: " + JSON.stringify(a.shoes.topMaker) + "; same model twice: " + (a.shoes.sameModel.length ? a.shoes.sameModel.join("; ") : "never")) : "-"}`,
  `About you (jackets, first 20): ${a.aboutYou ? (a.aboutYou.error || "not set: " + a.aboutYou.notSet.long + " long; short + slim: " + a.aboutYou.shortSlim.long + " long, " + a.aboutYou.shortSlim.suitYou + " that suit you — " + a.aboutYou.shortSlim.first.join(" / ")) : "-"}`,
  `Errors: ${(a.errors || []).join(" | ") || "none"}`,
  a.stuck ? `STUCK at start: ${JSON.stringify(a.stuck)}` : "",
  a.stuckAfter ? `STUCK after card ${a.stuckAfter.n}: ${JSON.stringify(a.stuckAfter)}` : "",
  R.crash ? `CRASH: ${R.crash}` : "",
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), md);
save();
console.log(md);
