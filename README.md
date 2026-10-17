# Drape

A personal style finder for menswear. Tell it what you're looking for, vote on style ideas (hate / like / love), and the ideas adapt to your votes. When one clicks, pick it and see real pieces to buy.

## Install on your phone

1. Open https://israeltoledano.github.io/Clothes/ in Safari.
2. Tap Share → **Add to Home Screen**.
3. Open it from the home screen. It runs full screen and works offline.

## How it works (v0.2)

- **Start**: pick a type of clothing, any styles, and optionally describe what you want in your own words.
- **Explore**: one idea at a time. Vote with the buttons or swipe (← hate, → like, ↑ love).
  - With Claude on, Claude writes the ideas in batches of 4 and asks for a new batch every two votes, so each batch reflects how you've voted. Three hates in a row make it change direction. Each idea gets an AI photo.
  - With Claude off, ideas come from a built-in sample list (`SAMPLE_IDEAS` in `index.html`).
  - Either way, a local taste model re-orders what's waiting after every vote.
- **Pick**: "This is it" asks for budget, size and shipping to Israel.
- **Shop**: real products from Google Shopping (Israel), filtered by budget, with Claude keeping the menswear items that match the idea. Store links are below as a backup.
- **Taste profile**: what you like and dislike, recent votes and picks, and the Claude connection. "Ask Claude about my style" shares a summary to the Claude app.

Everything you do is saved on the phone (`localStorage`, keys prefixed `clothes:`).

## AI server (Cloudflare Worker)

`worker/worker.js` holds the API keys so they never sit in the app. `wrangler.toml` is at the repo root so Cloudflare's GitHub integration deploys it, the same way as Gym Bro's push worker.

| Route | What it does | Service |
|---|---|---|
| `POST /ideas` | Writes new ideas from the request, today's votes and long-term taste | Claude API (`claude-sonnet-5-5`) |
| `GET /image` | Draws a photo for one idea | Workers AI, FLUX.1 schnell (no key) |
| `POST /shop` | Finds products and ranks the matches | Serper (Google Shopping) + Claude (`claude-haiku-5-5`) |
| `GET /health` | Checks the access code and which keys are set | — |

### Setup

1. **Claude key**: at console.anthropic.com add a little credit under Billing, then create a key under API keys.
2. **Shopping key**: sign up at serper.dev and copy the API key (2,500 free searches).
3. **Deploy**: in the Cloudflare dashboard go to Workers & Pages → Create → Import a repository → pick `Clothes` and keep the defaults. The worker is named `clothes-ai`.
4. **Secrets**: in the worker's Settings → Variables and Secrets, add three secrets: `ACCESS_CODE` (any passcode you choose), `ANTHROPIC_API_KEY` and `SERPER_API_KEY`.
5. **App**: open your taste profile → Claude connection, type the access code and tap Connect. If the worker's address isn't `https://clothes-ai.srul7022.workers.dev`, paste it under "Server address".

### Rough costs

- Claude ideas: about 1¢ per batch, so roughly 25¢ for a 40-vote session. Switch `CLAUDE_MODEL` in `wrangler.toml` to `claude-haiku-5-5` to make it much cheaper.
- Photos: free up to about 170 a day on Workers AI's free allowance. Over that, the app shows the idea without a photo.
- Shopping: the first 2,500 searches are free, then about $0.30 per 1,000. Ranking with Haiku costs a fraction of a cent per search.

## Files

- `index.html`: the whole app
- `manifest.json`, `sw.js`, `icon-*.png`: home-screen install and offline support (AI photos are cached on the phone)
- `worker/worker.js`, `wrangler.toml`: the AI server

When you change `index.html`, bump `CACHE` in `sw.js` and `APP_VERSION` in `index.html` so phones load the new version.
