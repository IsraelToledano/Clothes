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
const BRIEF = { type: "Shirts", styles: ["Smart-casual"], text: "Ralph Lauren style, j crew" };

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
  R.diag = await timed(async () => { const r = await fetch(WORKER + "/diag?code=" + encodeURIComponent(tok)); return { status: r.status, body: await r.json() }; });
  log("diag", R.diag);
  R.ideasApi = await timed(async () => {
    const r = await fetch(WORKER + "/ideas", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ code: tok, count: 2, angle: 1, round: "live", month: "October", query: BRIEF, votes: [], taste: {}, seen: [] }) });
    const j = await r.json();
    return { status: r.status, model: j.model, serverMs: j.ms, error: j.error, ideas: (j.ideas || []).map((i) => ({ title: i.title, why: i.why, colour: i.colour, fabric: i.fabric, search: i.search, image_prompt: i.image_prompt })) };
  });
  log("ideas (API)", R.ideasApi);
  R.imagesApi = [];
  for (const [n, i] of (R.ideasApi.ideas || []).slice(0, 1).entries()) {
    const res = await timed(async () => {
      const r = await fetch(WORKER + "/image?v=2&s=" + n + "&t=Shirts&code=" + encodeURIComponent(tok) + "&p=" + encodeURIComponent(i.image_prompt));
      const buf = Buffer.from(await r.arrayBuffer());
      const ext = (r.headers.get("content-type") || "").includes("png") ? "png" : "jpg";
      if (r.ok) fs.writeFileSync(path.join(OUT, `api-photo-${n + 1}.${ext}`), buf);
      return { status: r.status, model: r.headers.get("x-drape-image-model"), bytes: buf.length, error: r.ok ? undefined : buf.toString().slice(0, 300) };
    });
    R.imagesApi.push({ title: i.title, ...res });
    log("image (API)", i.title, res);
  }
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
    if (kind === "/ideas") { try { const j = await r.json(); e.model = j.model; e.serverMs = j.ms; e.count = (j.ideas || []).length; e.error = j.error; } catch (x) {} }
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
    const card = await page.evaluate(() => S.current && { id: S.current.id, title: S.current.title, why: S.current.why, colour: S.current.colour, fabric: S.current.fabric, desc: S.current.desc, boost: S.current._boost || 0 });
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
const ideas = reqs.filter((r) => r.kind === "/ideas"), imgs = reqs.filter((r) => r.kind === "/image");
const photoMs = (a.cards || []).map((c) => c.photoMs).filter((x) => x != null);
const md = [
  `# Drape live test — ${R.started}`,
  `Server: ${R.deployed} (expected ${R.expectedServer})`,
  `Diag: ${JSON.stringify(R.diag && R.diag.body)}`,
  `API ideas: ${R.ideasApi && (R.ideasApi.ok ? R.ideasApi.status + " in " + R.ideasApi.ms + "ms, model " + R.ideasApi.model : R.ideasApi.error)}`,
  ...(R.ideasApi && R.ideasApi.ideas || []).map((i) => `  - ${i.title} — why: ${i.why} — search: ${i.search}`),
  `API photos: ${(R.imagesApi || []).map((i) => i.status + " " + i.ms + "ms " + i.model + " " + i.bytes + "B" + (i.error ? " " + i.error : "")).join(" | ")}`,
  `App first card: ${a.firstCardMs == null ? "NOT SHOWN" : a.firstCardMs + "ms"}`,
  `App /ideas calls: ${ideas.map((r) => (r.status || "fail") + " " + r.ms + "ms " + (r.model || r.failed || r.error || "")).join(" | ")}`,
  `App photos: ${imgs.length} requests; ${imgs.filter((r) => r.status === 200).length} ok; models ${[...new Set(imgs.map((r) => r.model))].join(",")}; median card photo wait ${photoMs.length ? photoMs.sort((x, y) => x - y)[Math.floor(photoMs.length / 2)] + "ms" : "-"}`,
  `Cards (waited = from the previous swipe until the card was there; photo = until its photo was there):`, ...(a.cards || []).map((c) => `  ${c.n}. ${c.title} — ${c.colour}, ${c.fabric} — why: ${c.why || ""} — waited ${c.waitedMs}ms — photo ${c.photoMs == null ? "FAILED " + c.photoError : c.photoMs + "ms"} — ${c.swipe}${c.boost === 10 ? " (heart variation)" : ""}`),
  `Errors: ${(a.errors || []).join(" | ") || "none"}`,
  a.stuck ? `STUCK at start: ${JSON.stringify(a.stuck)}` : "",
  a.stuckAfter ? `STUCK after card ${a.stuckAfter.n}: ${JSON.stringify(a.stuckAfter)}` : "",
  R.crash ? `CRASH: ${R.crash}` : "",
].join("\n");
fs.writeFileSync(path.join(OUT, "summary.md"), md);
save();
console.log(md);
