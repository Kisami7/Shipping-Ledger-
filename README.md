# ShipLedger

A shopping-cart cost calculator: item prices, tax, currency conversion, card
fees, and forwarding-company shipping estimates, all in one page. No build
step — it runs straight from these static files.

## Deploy on GitHub Pages

1. Push all the files in this folder to the **root of your repo** (or to a
   `/docs` folder — either works, just point Pages at the right one).
2. In the repo: **Settings → Pages → Build and deployment → Source** →
   "Deploy from a branch", pick your branch and `/ (root)` (or `/docs`).
3. Save. GitHub gives you a URL like
   `https://<username>.github.io/<repo>/` within a minute or two.
4. Open it — the app loads React, Tailwind, and the JSX compiler from CDN
   at runtime, so there's nothing to build or install locally.

If you'd rather test it before pushing: `cd` into this folder and run any
static server, e.g. `python3 -m http.server`, then open
`http://localhost:8000`.

## Turning it into an "app"

This is already a installable **PWA (Progressive Web App)** — that's the
realistic way to get an "app" out of a website without going through an app
store:

- **Android / desktop Chrome, Edge:** visit the Pages URL, then use the
  install icon in the address bar (or the browser menu → "Install
  ShipLedger"). It installs as a standalone window with its own icon.
- **iPhone / iPad (Safari):** open the URL → Share → **Add to Home Screen**.
  It launches full-screen, without Safari's address bar, like a native app.

Once installed, `service-worker.js` caches the app shell so it still opens
if you're offline — though currency refresh and first-time CDN loads still
need a connection.

## Data storage

Your carts, companies, and settings (including your Open Exchange Rates
key) are saved in the browser's `localStorage`, scoped to whatever domain
you deploy this on. That means:

- Data doesn't sync between devices — it's local to each browser/device.
- Clearing your browser's site data for that domain will erase it.
- Nothing is sent anywhere except the currency API call you trigger with
  the refresh button.

## Files

| File | Purpose |
|---|---|
| `index.html` | Entry point — loads React/Tailwind/Babel from CDN and mounts the app |
| `app.jsx` | The entire app (components, calculations, screens) |
| `manifest.json` | PWA metadata (name, icons, colors) for installability |
| `service-worker.js` | Offline caching of the app shell |
| `icons/` | App icons at the sizes each platform expects |
