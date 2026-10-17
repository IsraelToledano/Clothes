# Drape

A personal style finder for menswear. Tell it what you're looking for, vote on style ideas (hate / like / love), and the ideas adapt to your votes. When one clicks, pick it and search for it in real stores.

Completely free: no API keys and no credit card.

## Install on your phone

1. Open https://israeltoledano.github.io/Clothes/ in Safari.
2. Tap Share → **Add to Home Screen**.
3. Open it from the home screen. It runs full screen and works offline.

## How it works (v0.3)

- **Start**: pick a type of clothing, any styles, and optionally describe what you want in your own words.
- **Explore**: one idea at a time. Vote with the buttons or swipe (← hate, → like, ↑ love).
  - With AI on, an AI model writes the ideas in batches of 4, with a new batch every three votes, so each batch reflects how you've voted. Three hates in a row make it change direction. Each idea gets an AI photo.
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
| `GET /image` | Draws a photo for one idea | FLUX.1 schnell (`@cf/black-forest-labs/flux-1-schnell`) |
| `GET /health` | Checks the access code | — |

### Setup

1. In the Cloudflare dashboard go to Workers & Pages → Create → Import a repository → pick `Clothes` and keep the defaults. The worker is named `clothes`.
2. In the worker's Settings → Variables and Secrets, add one secret: `ACCESS_CODE`, set to any passcode you choose.
3. In the app, open your taste profile → AI connection, type the access code and tap Connect. If the worker's address isn't `https://clothes.srul7022.workers.dev`, paste it under "Server address".

### The free limit

Workers AI gives 10,000 free "neurons" a day, shared by ideas and photos. That's roughly 70 votes a day. It resets at 00:00 UTC (03:00 in Israel). On the free plan Cloudflare blocks requests past the limit instead of charging, so the app shows sample ideas until it resets.

## Files

- `index.html`: the whole app
- `manifest.json`, `sw.js`, `icon-*.png`: home-screen install and offline support (AI photos are cached on the phone)
- `worker/worker.js`, `wrangler.toml`: the AI server

When you change `index.html`, bump `CACHE` in `sw.js` and `APP_VERSION` in `index.html` so phones load the new version.
