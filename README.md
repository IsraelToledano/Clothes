# Drape

A personal style finder for menswear. Tell it what you're looking for, vote on style ideas (hate / like / love), and the ideas adapt to your votes. When one clicks, pick it and it points you to real pieces to buy.

## Install on your phone

1. Open the app's GitHub Pages link in Safari.
2. Tap Share → **Add to Home Screen**.
3. Open it from the home screen. It runs full screen and works offline.

## How it works now (v0.1)

- **Start**: pick a type of clothing, any styles, and optionally describe what you want in your own words.
- **Explore**: one idea at a time. Vote with the buttons or swipe (← hate, → like, ↑ love). After a few votes the app shows how it's adjusting.
- **Pick**: "This is it" asks for budget, size and shipping to Israel.
- **Shop**: for now, opens the search in Google Shopping or ASOS. Live product results come next.
- **Taste profile**: what you like and dislike, recent votes and picks. "Ask Claude about my style" shares a summary to the Claude app.

Ideas come from a built-in sample list (`SAMPLE_IDEAS` in `index.html`) and are ranked by a simple taste model. Everything is saved on the phone (`localStorage`, keys prefixed `clothes:`).

## Next

A Cloudflare Worker that holds the API keys and connects:

- **Claude API**: writes new ideas from what you asked for and how you voted.
- **An image model**: an AI photo for each idea.
- **A shopping search**: real products from Israeli and international stores.

Then set `AI_MODE = true` in `index.html`.

## Files

- `index.html`: the whole app
- `manifest.json`, `sw.js`, `icon-*.png`: home-screen install and offline support

When you change `index.html`, bump `CACHE` in `sw.js` and `APP_VERSION` in `index.html` so phones load the new version.
