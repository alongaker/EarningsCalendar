# Earnings Calendar

A small website for **upcoming earnings calls**: ticker, company, before-open vs after-close, market cap, and consensus EPS. Run it on a local server while you iterate, then publish the same files to GitHub Pages.

Live data comes from Nasdaq’s public earnings calendar. The site is a calendar, not investment advice.

## Run it locally

You need Node 18+.

```bash
npm run fetch    # pull the next 21 days into data/earnings.json
npm start        # local server at http://localhost:3000
```

Open **http://localhost:3000** in a normal browser. If a Cloud Agent is running this, use Cursor Desktop’s Agents Window (plug icon in the editor) so port 3000 is forwarded to your machine — skip the remote desktop viewer.

The local server serves the page and a live API:

| URL | What it does |
| --- | --- |
| `/` | The Earnings Calendar UI |
| `/api/earnings` | Fresh Nasdaq fetch (cached 10 minutes) |
| `/api/earnings?live=0` | The saved `data/earnings.json` snapshot |
| `/api/provider/:name` | `POST` JSON `{ apiKey, from, to }` for `finnhub`, `fmp`, or `alphavantage` |
| `/api/company/:symbol` | Nasdaq quote, profile, and recent earnings surprises |

Press `/` on the page to jump to search. Filter by call time or market cap, or click a day in the week strip. Click a company row to open its page (quote, profile, upcoming call, recent earnings).

The **API keys** tab stores Finnhub, Financial Modeling Prep, and Alpha Vantage keys in this browser. Saved keys are used to merge extra tickers, revenue estimates, and confirmed times into the calendar. They are not written to the repo.

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
providers.js               # extra API key providers
company.js                 # company profile lookup
server.js                  # local static + API server
scripts/fetch-earnings.mjs # writes data/earnings.json
scripts/earnings-lib.mjs   # Nasdaq fetch + cleanup
data/earnings.json         # snapshot used on Pages
```
