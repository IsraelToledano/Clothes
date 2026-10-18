# Drape

A personal style finder for menswear. Tell it what you're looking for, swipe right (heart) when an idea is getting closer and left (X) when it's not right now, and it zeroes in on the one piece you have in mind. Save the ones you like, and when one clicks, pick it and search for it in real stores.

Completely free: no API keys and no credit card.

## Install on your phone

1. Open https://israeltoledano.github.io/Clothes/ in Safari.
2. Tap Share → **Add to Home Screen**.
3. Open it from the home screen. It runs full screen and works offline.

## How it works (v0.3)

- **Start**: pick a type of clothing, any styles, and optionally describe what you want in your own words.
- **Explore**: one idea at a time. Swipe: ← not now, → getting closer (← and → keys work too; screen readers get buttons). Not now is a gentle signal about that piece, not a ban on its style. **Save** keeps a piece in your profile, separate from buying it, and saved pieces shape future searches. A heart makes the AI write variations of that piece in the background; they come right after the next two cards.
  - With AI on, the first search asks for about 20 ideas at once (four requests in parallel). Each batch is given different kinds of garment (for shirts: oxford, linen, madras, rugby, chambray, camp collar...), so you don't get one shirt in five colours. Your own words lead the brief, and brands you name (Ralph Lauren, J.Crew, COS...) are spelled out for the AI as concrete styles. More ideas are written in the background whenever fewer than eight are left, using your latest swipes. Four "not now" in a row make it change direction. The photos of the next three cards are drawn ahead, so swiping doesn't wait.
  - With AI off, or when today's free AI allowance runs out, ideas come from a built-in sample list (`SAMPLE_IDEAS` in `index.html`).
  - Either way, a local taste model re-orders what's waiting after every vote.
- **Pick**: "This is it" asks for budget, size and shipping to Israel.
- **Shop**: opens the idea's search in stores, grouped and ordered by your budget: Google Shopping (Israel with your budget, and worldwide) and Lyst; Israel (Zara, Terminal X, Factory 54, Massimo Dutti); international stores that ship to Israel (ASOS, Amazon, END., Mr Porter, Farfetch); brands (Ralph Lauren, J.Crew); budget (Shein, AliExpress, eBay); and "See it styled" (GQ, Vogue, Pinterest, Google Images). Stores without a known search link open a Google search of that store's site.
- **Send to Claude** (the sparkle button in the top bar of every screen): one tap shares a screenshot of the current screen plus a data file (app version, what's on screen, this round's votes, your taste, AI status and errors) to a Claude chat, like in Gym Bro and Skin Ritual. The access code is never included.
- **Taste profile**: what you like and dislike, recent votes and picks, and the AI connection. "Ask Claude about my style" shares a summary to the Claude app.

Everything you do is saved on the phone (`localStorage`, keys prefixed `clothes:`).

## AI server (Cloudflare Worker, free)

`worker/worker.js` runs on Cloudflare Workers AI. `wrangler.toml` is at the repo root so Cloudflare's GitHub integration deploys it, the same way as Gym Bro's push worker.

| Route | What it does | Model |
|---|---|---|
| `POST /ideas` | Writes new ideas from the request, today's votes and long-term taste | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) |
| `GET /image` | Draws a product photo for one idea (the garment alone on an invisible mannequin, no person) | FLUX.2 klein 4B (`@cf/black-forest-labs/flux-2-klein-4b`), 512×768; FLUX.1 schnell as backup |
| `GET /health` | Checks the access code | — |

### Setup

1. In the Cloudflare dashboard go to Workers & Pages → Create → Import a repository → pick `Clothes` and keep the defaults. The worker is named `clothes`.
2. In the worker's Settings → Variables and Secrets, add one secret: `ACCESS_CODE`, set to any passcode you choose.
3. In the app, open your taste profile → AI connection, type the access code and tap Connect. If the worker's address isn't `https://clothes.srul7022.workers.dev`, paste it under "Server address".

### The free limit

Workers AI gives 10,000 free "neurons" a day, shared by ideas and photos. A search costs about 1,000 to start (around 20 ideas written at once), then about 100 per card (its photo plus its share of new ideas): roughly 80–90 swipes a day. It resets at 00:00 UTC (03:00 in Israel). On the free plan Cloudflare blocks requests past the limit instead of charging, so the app shows sample ideas until it resets.

## Files

- `index.html`: the whole app
- `manifest.json`, `sw.js`, `icon-*.png`: home-screen install and offline support (AI photos are cached on the phone)
- `worker/worker.js`, `wrangler.toml`: the AI server

When you change `index.html`, bump `CACHE` in `sw.js` and `APP_VERSION` in `index.html` so phones load the new version.

On the phone, tap the version badge next to the logo (or **Update app** in the taste profile) to load the latest version. It keeps your search, votes and the round in progress, then says whether it updated.
