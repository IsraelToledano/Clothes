# Drape

A personal style finder for menswear. Tell it what you're looking for, then swipe through **real pieces from real stores** (their own photos, prices and links): right when a piece is getting closer, left when it's not right now. Hearts make the AI search for close alternatives; Save keeps pieces; "This is it" opens the piece in its store.

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
| `POST /ideas` | Writes new ideas from the brief, today's swipes and long-term taste | Gemma 4 26B (`@cf/google/gemma-4-26b-a4b-it`); Llama 3.3 70B as backup |
| `GET /diag` | One tiny test call per model with Cloudflare's exact answer ("Run a quick AI check" in the app; the result goes into the Drape report) | all three |
| `GET /image` | Draws a product photo for one idea (the garment alone on an invisible mannequin, no person) | First five cards of a search: FLUX.1 schnell (1–2s, about 150 neurons). The rest: FLUX.2 klein 4B at 512×768 (9–14s, about 50 neurons), drawn ahead while you look at the current card. Each is the other's backup. |
| `GET /health` | Checks the access code | — |

### Setup

1. In the Cloudflare dashboard go to Workers & Pages → Create → Import a repository → pick `Clothes` and keep the defaults. The worker is named `clothes`.
2. In the worker's Settings → Variables and Secrets, add one secret: `ACCESS_CODE`, set to any passcode you choose.
3. In the app, open your taste profile → AI connection, type the access code and tap Connect. If the worker's address isn't `https://clothes.srul7022.workers.dev`, paste it under "Server address".

### The free limit

Workers AI gives 10,000 free "neurons" a day, shared by ideas and photos. Measured: a schnell photo costs about 150 (1024px, billed per tile and step), a klein photo about 50, and ideas about 10 each with Gemma. A search costs about 1,050 to start (about 20 ideas and the first five photos), then about 60 per card: roughly 130 cards a day. It resets at 00:00 UTC (03:00 in Israel in summer). Going over the limit can keep requests blocked for some hours. On the free plan Cloudflare blocks requests past the limit instead of charging, so the app shows sample ideas until then.

## Files

- `index.html`: the whole app
- `manifest.json`, `sw.js`, `icon-*.png`: home-screen install and offline support (AI photos are cached on the phone)
- `worker/worker.js`, `wrangler.toml`: the AI server

When you change `index.html`, bump `CACHE` in `sw.js` and `APP_VERSION` in `index.html` so phones load the new version.

On the phone, tap the version badge next to the logo (or **Update app** in the taste profile) to load the latest version. It keeps your search, votes and the round in progress, then says whether it updated.

## Real products (since 1.0)

AI-drawn photos on the free plan were too generic and too slow, so Drape shows real products: real photos, prices and links.

- **Catalog** (`catalog/`, rebuilt daily by `.github/workflows/catalog.yml` → `scripts/build-catalog.mjs`): the current menswear of about 18 Shopify stores (Rowing Blazers, Alex Mill, Todd Snyder, Drake's, Aimé Leon Dore, Taylor Stitch, Noah, Percival, Portuguese Flannel, Oliver Spencer, Universal Works, Kith, Corridor, Outerknown and more), from each store's public `/products.json`. Women's and kids' pieces, accessories and sold-out items are left out; each piece gets a type (Shirts, Knitwear...), colour and fabric. About 19,000 pieces from 44 stores, one JSON file per type (the first 3 photos of each; photos 4–8 come with the details), served by GitHub Pages with the app.
- **Searching** happens on the phone: the stores that fit the brief (each store has style tags; chips, brands and words in your text map to them), words from your text, your swipes, and a little per-search randomness. Never the same store or kind of piece twice in a row, and never the same piece twice in a search. Instant, and the stores never see a burst of requests (live searches from the worker got rate-limited by Shopify).
- **AI** (Gemma, `POST /keywords`): reads the brief, and each heart, as words to look for (e.g. "oxford", "madras", "rugby stripe") and the stores that fit. A heart also puts the closest pieces right after the next card.
- Settings in the pick sheet still apply: "Only stores that ship to Israel" (from each store's settings) and the budget.

### Categories and styles (since 1.7)

- **What kind of piece** is one choice from a list (on the iPhone, a wheel): Tops (T-shirts, polos & rugbys, shirts, overshirts, knitwear, sweatshirts & hoodies), Tailoring (suits, blazers & sport coats), Outerwear (jackets, coats), Bottoms (trousers & chinos, jeans, shorts, swimwear), Shoes (all, sneakers, boots, loafers & smart shoes, sandals & slides), Accessories (all, hats & caps, bags, belts & braces, scarves & gloves, ties & pocket squares, socks, sunglasses, wallets), or Anything. The catalog has a file per type (`FILES`); Sneakers, Boots, Hats... are kinds within Shoes and Accessories (`CAT_DEF`).
- **The catalog's types**: the word that ends last in a name decides ("Bandana Print Camp Shirt" is a shirt, "Belt Bag" a bag), ignoring a colour ending ("Manuel Blazer - Peacoat"); a store's type that's a narrower kind of what the name says wins ("Dylan Jacket" filed as Blazers is a blazer); shoes trust the store's type.
- **Styles** are any number of tags in two groups: Look (relaxed, minimal, smart-casual, classic, tailored, preppy, Ivy & Americana, quiet luxury, streetwear, vintage, workwear, rugged, outdoor, sporty, coastal, Scandinavian, Japanese) and Colours & patterns (neutrals, earth tones, blues & navy, black, pastels, bold colour, stripes, checks & plaids, prints). Each is read like a brand in your words (`STYLE_READS`): store styles, stores, words to look for and avoid (whole words: "red" isn't in "tailored"). The card says which: "Preppy: oxford, button-down".

### About you (since 1.6)

In the taste profile (or "Add your height and build" on the start screen): height (under 170 / 170–182 / over 182 cm), build (slim, average, athletic, broad), the fit you like, your size and shoe size. They change what comes first: for a short build, fewer long coats (overcoats, topcoats, trench, longline: from the title and the store's description, read by the catalog as "ct") and wide trousers, more cropped jackets (bomber, Harrington, trucker...) and shorter shorts (inseam "is"); for a slim build, fewer oversized/boxy pieces and more slim, tapered and tailored cuts; letter sizes in stock without yours come last. The card says why ("Cropped, good for your height") or warns ("Long for your height"), and the AI's reading of your brief gets it too.

### The card (since 1.5)

- **A clean photo**: on the photo there's only the photo and thin bars for its other photos. Swipe it (← not now, → getting closer), tap its sides for the other photos and its middle for full screen. Name, store, price and the reason are under it; Back (↶), Save and "This is it" below them; scroll down for every photo, colour, fabric, sizes in stock, the store's description and "Find similar in other stores".
- **Back (↶)** returns to the previous piece and takes back the answer you gave it, as many steps as you like.
- **No repeats of one model**: the same model in another colour, or at another store, counts as one piece (shared name words, or the same maker's model number like 991/990). A search also moves between makers (New Balance, Allen Edmonds...) and, for shoes, between 16 kinds (loafers, chukkas, Chelsea boots, court and running sneakers, derbies, oxfords, monk straps, boat shoes, espadrilles...).

### Your words, your taste and your pieces (since 1.3)

- **Brands in your own words** count at once, on the phone, without waiting for the AI: Ralph Lauren, Club Monaco, J.Crew, Brooks Brothers, J.Press, Banana Republic, Todd Snyder, Aimé Leon Dore, COS/Uniqlo, Massimo Dutti and "quiet luxury" are each read as store styles to favour and avoid, words to look for (oxford, button-down, polo, rugby, poplin, linen...) and words to avoid (western, snap, graphic...), plus the stores closest to them (`BRAND_READS` in `index.html`). A store you name that's in the catalog (Club Monaco, Drake's...) is favoured too. Each card's blue line says what it matched: "Like Ralph Lauren: oxford, button-down".
- **Long-term taste is fair to what you see most**: something counts for you when you liked pieces with it more often than you like pieces in general (smoothed). Before 1.3 every "not now" pushed against everything in the piece, so the most common things (cotton, relaxed fit, even the smart-casual you asked for) piled up against you.
- **Your pieces** (the bookmark at the top): **Saved** and **Liked** (every piece you swiped right on). Liked pieces from before 1.3 are found again from your votes.
- **More stores** that fit classic briefs and ship to Israel: Club Monaco (its men's collection), J.Press, Grayers, Kamakura Shirts, Sunspel, Private White V.C. and Colhay's. The catalog also stopped dropping cream, printed, patch-pocket and tie-dye pieces and men's "dress" trousers and shirts, and now types sweatshirts, hoodies, outerwear and jeans. `stores.json` reports how many pieces each store had and why the rest were left out.

### Photos and details (since 1.2)

- **On the card**: bars at the top show how many photos a piece has (up to 8). Tap the right or left side of the photo for the next or previous one, like Tinder. A tap never votes; only a swipe does.
- **Details**: tap the text under the photo, the ⓘ button, or swipe up. All the photos (swipe through them or tap a thumbnail), price (with the full price when it's on sale), colour, fabric, fit, sizes in stock and sold out (your size is marked), the other colours it comes in, and the store's own description. ✕ / Save / ♥ at the bottom answer for the card, the same as a swipe. "View at …" opens it in the store.
- **Full screen**: tap the middle of the photo on the card (or its magnifier button), or any photo in the details. It opens filling the screen (up to twice the fitted size); pinch out to see all of it, double-tap to go closer and again to come back, flick sideways for the next photo. Pinch or double-tap to zoom (up to 5×), drag to look around, swipe sideways for the next photo, swipe down or ✕ to close. It loads a 2000px copy from the store. The phone's back gesture closes it, then the details.
- **Saved**: the bookmark at the top (with a count) opens a grid of saved pieces; each opens the same details view.
- **Catalog format 2**: each store's photo folder is in `stores.json` (`ip`) and each photo is saved without it or a size; the app asks the store's image server for the size it needs (200 for lists, 900 for cards, 2000 for zoom). Longer details (description, sold-out sizes, colours, maker) are in `catalog/details/000.json`–`127.json`, chosen by a hash of the piece's id, and loaded only when a piece is opened (about 30–50 KB each). `catalog.yml` can also be run with `target: preview` to build into the `catalog-preview` branch without publishing.

Ralph Lauren and J.Crew themselves don't publish their products this way, so they stay as search links on "Find similar in other stores".

## Live test

`.github/workflows/live-test.yml` runs the real app against the real worker (Actions → live test → Run workflow). It signs in with a short-lived GitHub token for this repo (no stored secret), swipes through eight cards with a fixed brief, then flips through a card's photos, opens its details and the full-screen photo (double-tap zoom), saves it and opens Saved; it saves timings, errors, screenshots and the AI photos to the `live-results` branch. One run uses roughly 1,000–1,500 of the 10,000 daily neurons.
