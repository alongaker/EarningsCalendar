# Call Sheet

A small website for **upcoming earnings calls**: ticker, company, before-open vs after-close, market cap, and consensus EPS. Run it on a local server while you iterate, then publish the same files to GitHub Pages.

Live data comes from Nasdaq’s public earnings calendar. The site is a calendar, not investment advice.

## Run it locally

You need Node 18+.

```bash
npm run fetch    # pull the next 21 days into data/earnings.json
npm start        # local server at http://localhost:3000
```

The local server serves the page and a live API:

| URL | What it does |
| --- | --- |
| `/` | The Call Sheet UI |
| `/api/earnings` | Fresh Nasdaq fetch (cached 10 minutes) |
| `/api/earnings?live=0` | The saved `data/earnings.json` snapshot |
| `/api/health` | Server ping |

Press `/` on the page to jump to search. Filter by call time or market cap, or click a day in the week strip.

## Publish on GitHub Pages

This repo is already wired for Pages:

1. In the GitHub repo: **Settings → Pages → Source → GitHub Actions**.
2. Merge to `main`. The deploy workflow publishes `index.html`, CSS, JS, and `data/earnings.json`.
3. The site will be at `https://alongaker.github.io/EarningsCalendar/`.

On GitHub Pages there is no Node server, so the page reads the snapshot file. A weekday GitHub Action refreshes that file (or run **Actions → Update earnings data → Run workflow**).

## Project layout

```
index.html                 # page
styles.css / app.js        # UI
server.js                  # local static + API server
scripts/fetch-earnings.mjs # writes data/earnings.json
scripts/earnings-lib.mjs   # Nasdaq fetch + cleanup
data/earnings.json         # snapshot used on Pages
```
