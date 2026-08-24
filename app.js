import { PROVIDERS, providersByName, providerById, fetchProvider, mergeCalls, formatCompanyName, formatEps, canonicalSymbol, marketDateIso, windowUpcoming, formatMarketCap } from "./providers.js";
import { fetchNasdaqCompany, isSymbol, roundToHundredth, enrichSparseCalls } from "./company.js";

const TIME_LABEL = {
  "before-open": "Before open",
  "after-close": "After close",
  "during-session": "During session",
  unspecified: "Time TBD",
};

const SOURCE_LABEL = {
  nasdaq: "Nasdaq",
  finnhub: "Finnhub",
  fmp: "FMP",
  alphavantage: "Alpha Vantage",
  apininjas: "API Ninjas",
  eodhd: "EODHD",
  twelvedata: "Twelve Data",
};

const KEYS_STORAGE = "earningsCalendar.apiKeys.v1";
const NAV_STORAGE = "earningsCalendar.sidenav.v1";

const state = {
  base: null,
  snapshot: null,
  query: "",
  time: "all",
  minCap: 0,
  day: "all",
  tab: "calendar",
  keys: loadKeys(),
  statuses: {},
  companySymbol: "",
  companyDate: "",
  companyCache: {},
};

const els = {
  asOf: document.querySelector("#as-of"),
  source: document.querySelector("#source-line"),
  week: document.querySelector("#week"),
  board: document.querySelector("#board"),
  q: document.querySelector("#q"),
  viewCalendar: document.querySelector("#view-calendar"),
  viewKeys: document.querySelector("#view-keys"),
  viewCompany: document.querySelector("#view-company"),
  keyForm: document.querySelector("#key-form"),
  keySource: document.querySelector("#key-source"),
  keyValue: document.querySelector("#key-value"),
  keyHint: document.querySelector("#key-hint"),
  keyList: document.querySelector("#key-list"),
  keyFormStatus: document.querySelector("#key-form-status"),
  navToggle: document.querySelector("#nav-toggle"),
  navKeysText: document.querySelector("#nav-keys-text"),
  navLinks: document.querySelector("#sidenav-nav"),
};

function loadKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS_STORAGE) || "{}");
    const keys = {};
    for (const provider of PROVIDERS) {
      keys[provider.id] = String(raw[provider.id] || "").trim();
    }
    return keys;
  } catch {
    return Object.fromEntries(PROVIDERS.map((p) => [p.id, ""]));
  }
}

function saveKeys() {
  localStorage.setItem(KEYS_STORAGE, JSON.stringify(state.keys));
}

function connectedCount() {
  return PROVIDERS.filter((p) => state.keys[p.id]).length;
}

function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function weekday(iso) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(fmtDate(iso));
}

function longDate(iso) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(fmtDate(iso));
}

function shortDate(iso) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(fmtDate(iso));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function matches(call) {
  const q = state.query.trim().toLowerCase();
  if (q && !`${call.symbol} ${call.name}`.toLowerCase().includes(q)) return false;
  if (state.time !== "all" && call.time !== state.time) return false;
  if (call.marketCap < state.minCap) return false;
  if (state.day !== "all" && call.date !== state.day) return false;
  return true;
}

function groupByDate(calls) {
  const map = new Map();
  for (const call of calls) {
    if (!map.has(call.date)) map.set(call.date, []);
    map.get(call.date).push(call);
  }
  return [...map.entries()];
}

function sourceNames(snap) {
  const ids = new Set();
  for (const call of snap.calls || []) {
    for (const src of call.sources || ["nasdaq"]) ids.add(src);
  }
  if (!ids.size) ids.add("nasdaq");
  return [...ids].map((id) => SOURCE_LABEL[id] || id);
}

function setView(tab, opts = {}) {
  state.tab = tab;
  state.companySymbol = opts.symbol || "";
  state.companyDate = opts.date || "";
  els.viewCalendar.hidden = tab !== "calendar";
  els.viewKeys.hidden = tab !== "keys";
  els.viewCompany.hidden = tab !== "company";
  document.querySelectorAll(".sidenav__link").forEach((link) => {
    const on = link.dataset.nav === (tab === "company" ? "calendar" : tab);
    link.classList.toggle("is-on", on);
    link.setAttribute("aria-current", on ? "page" : "false");
  });
  const n = connectedCount();
  if (els.navKeysText) els.navKeysText.textContent = n ? `API keys · ${n}` : "API keys";
  if (opts.updateHash !== false) {
    let hash = "#calendar";
    if (tab === "keys") hash = "#keys";
    if (tab === "company" && state.companySymbol) {
      hash = state.companyDate
        ? `#company/${state.companySymbol}/${state.companyDate}`
        : `#company/${state.companySymbol}`;
    }
    if (location.hash !== hash) history.pushState(null, "", hash);
  }
  if (tab === "keys") {
    els.asOf.textContent = n
      ? `${n} extra provider${n === 1 ? "" : "s"} connected`
      : "No extra providers yet";
    els.source.textContent = "Keys stay in this browser";
    renderKeysPage();
  } else if (tab === "company" && state.companySymbol) {
    showCompany(state.companySymbol, state.companyDate);
  } else if (state.snapshot) {
    render();
  }
}

function dash(value) {
  const rounded = roundToHundredth(value);
  return rounded !== null && rounded !== undefined && String(rounded).trim() !== ""
    ? escapeHtml(rounded)
    : "—";
}

function formatCapLabel(value) {
  if (!value) return "—";
  const n = Number(String(value).replace(/[$,]/g, ""));
  if (Number.isFinite(n) && n > 0) return formatMarketCap(n);
  return String(value);
}

function displayName(value) {
  return formatCompanyName(value) || "";
}

function epsCell(call) {
  if (call.epsForecast) return escapeHtml(call.epsForecast);
  if (call.lastEpsDisplay) {
    return `<span class="eps-last" title="Last reported EPS">${escapeHtml(call.lastEpsDisplay)}</span>`;
  }
  return "—";
}

function hydrateCallsFromProfile(symbol, profile) {
  if (!state.snapshot?.calls || !profile) return;
  const ticker = canonicalSymbol(symbol);
  const capNum = Number(String(profile.marketCap || "").replace(/[$,]/g, ""));
  const last = profile.earningsHistory?.[0];
  let changed = false;
  const calls = state.snapshot.calls.map((call) => {
    if (canonicalSymbol(call.symbol) !== ticker) return call;
    const next = { ...call };
    const name = displayName(profile.name || next.name);
    if (name && next.name !== name) {
      next.name = name;
      changed = true;
    }
    if (!next.marketCap && Number.isFinite(capNum) && capNum > 0) {
      next.marketCap = capNum;
      next.marketCapDisplay = formatCapLabel(profile.marketCap);
      changed = true;
    }
    if (!next.epsForecast && last && last.eps !== "" && last.eps != null) {
      const lastEps = formatEps(last.eps);
      if (lastEps && next.lastEpsDisplay !== lastEps) {
        next.lastEpsDisplay = lastEps;
        changed = true;
      }
    }
    return next;
  });
  if (changed) state.snapshot = { ...state.snapshot, calls, count: calls.length };
}

function callsForSymbol(symbol) {
  return (state.snapshot?.calls || []).filter((call) => call.symbol === symbol);
}

async function loadCompanyProfile(symbol) {
  try {
    const res = await fetch(`/api/company/${encodeURIComponent(symbol)}`, { cache: "no-store" });
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await res.json();
      if (res.ok && payload.symbol) return payload;
      if (res.status !== 404) throw new Error(payload.error || `company ${res.status}`);
    }
  } catch (err) {
    const msg = err.message || "";
    if (msg && !/Failed to fetch|NetworkError|Unexpected token|JSON/i.test(msg)) {
      throw err;
    }
  }
  return fetchNasdaqCompany(symbol);
}

function renderCompany(symbol, profile) {
  const upcoming = callsForSymbol(symbol);
  const selected = upcoming.find((c) => c.date === state.companyDate) || upcoming[0];
  const name = displayName(profile?.name || selected?.name || symbol);
  const dir = profile?.direction === "down" ? "down" : profile?.direction === "up" ? "up" : "";
  const chg = [profile?.netChange, profile?.percentageChange]
    .filter(Boolean)
    .map((part) => roundToHundredth(part))
    .join("  ");
  const websiteUrl = /^https?:\/\//i.test(profile?.website || "") ? profile.website : "";
  const website = websiteUrl
    ? `<p><a href="${escapeHtml(websiteUrl)}" target="_blank" rel="noopener">${escapeHtml(websiteUrl.replace(/^https?:\/\//, ""))}</a></p>`
    : "";
  const loading = profile?.loading
    ? `<p class="status">Loading quote and company profile…</p>`
    : "";
  const error =
    (profile?.error || profile?.nasdaqError)
      ? `<p class="empty">Live quote unavailable. ${escapeHtml(profile.error || profile.nasdaqError)}</p>`
      : "";

  const capDisplay =
    formatCapLabel(profile?.marketCap) !== "—"
      ? formatCapLabel(profile.marketCap)
      : selected?.marketCapDisplay || "";
  const lastEarn = profile?.earningsHistory?.[0];
  const latestFiling = profile?.filings?.[0];
  const filingCell = latestFiling
    ? `<a href="${escapeHtml(latestFiling.documentUrl || latestFiling.indexUrl)}" target="_blank" rel="noopener">${escapeHtml(latestFiling.form)}${latestFiling.filed ? ` · ${escapeHtml(latestFiling.filed)}` : ""}</a>`
    : "";

  const callCards = upcoming.length
    ? upcoming
        .map((call) => {
          const extras = (call.sources || []).filter((s) => s !== "nasdaq");
          const tags = extras
            .map((s) => `<span class="tag">${escapeHtml(SOURCE_LABEL[s] || s)}</span>`)
            .join("");
          const callCap =
            call.marketCapDisplay && call.marketCapDisplay !== "—"
              ? call.marketCapDisplay
              : capDisplay;
          return `<article class="upcoming-call">
            <h3>${call === selected ? "This call" : "Also on the calendar"}</h3>
            <p><span class="time-badge ${call.time}">${TIME_LABEL[call.time]}</span> · ${longDate(call.date)}${tags}</p>
            <dl class="stat-grid">
              <div><dt>EPS est.</dt><dd>${dash(call.epsForecast)}</dd></div>
              <div><dt>Rev est.</dt><dd>${dash(call.revenueEstimateDisplay)}</dd></div>
              <div><dt>Quarter</dt><dd>${dash(call.fiscalQuarterEnding)}</dd></div>
              <div><dt>Last year EPS</dt><dd>${dash(call.lastYearEPS)}</dd></div>
              <div><dt># estimates</dt><dd>${dash(call.estimateCount || "")}</dd></div>
              <div><dt>Market cap</dt><dd>${dash(callCap)}</dd></div>
            </dl>
          </article>`;
        })
        .join("")
    : `<p class="empty">No upcoming call for this ticker is on the current calendar.</p>`;

  const history = (profile?.earningsHistory || []).length
    ? `<section class="history">
        <h3>Recent earnings</h3>
        <table class="table">
          <thead>
            <tr>
              <th>Quarter</th>
              <th>Reported</th>
              <th>EPS</th>
              <th>Est.</th>
              <th>Surprise</th>
            </tr>
          </thead>
          <tbody>
            ${profile.earningsHistory
              .map(
                (row) => `<tr>
                  <td>${dash(row.fiscalQtrEnd)}</td>
                  <td>${dash(row.dateReported)}</td>
                  <td class="num">${dash(row.eps)}</td>
                  <td class="num">${dash(row.consensus)}</td>
                  <td class="num">${row.surprise === "" || row.surprise === null ? "—" : `${escapeHtml(row.surprise)}%`}</td>
                </tr>`
              )
              .join("")}
          </tbody>
        </table>
      </section>`
    : "";

  const filings = (profile?.filings || []).length
    ? `<section class="filings history">
        <h3>SEC filings</h3>
        <p class="company-hero__meta">${profile.cik ? `CIK ${escapeHtml(profile.cik)}` : ""}${
          profile.sic ? ` · ${escapeHtml(profile.sic)}` : ""
        } · EDGAR</p>
        <table class="table">
          <thead>
            <tr>
              <th>Form</th>
              <th>Filed</th>
              <th>Period</th>
              <th>Document</th>
            </tr>
          </thead>
          <tbody>
            ${profile.filings
              .map((row) => {
                const doc = row.documentUrl
                  ? `<a href="${escapeHtml(row.documentUrl)}" target="_blank" rel="noopener">Open</a>`
                  : "";
                const index = row.indexUrl
                  ? `<a href="${escapeHtml(row.indexUrl)}" target="_blank" rel="noopener">index</a>`
                  : "";
                const links = [doc, index].filter(Boolean).join(" · ") || "—";
                return `<tr>
                  <td class="symbol">${escapeHtml(row.form)}</td>
                  <td>${dash(row.filed)}</td>
                  <td>${dash(row.reportDate)}</td>
                  <td>${links}</td>
                </tr>`;
              })
              .join("")}
          </tbody>
        </table>
      </section>`
    : profile?.edgarError
      ? `<p class="empty">SEC filings unavailable. ${escapeHtml(profile.edgarError)}</p>`
      : "";

  const overview =
    profile && !profile.loading
      ? `<section class="overview history">
        <h3>Overview</h3>
        <dl class="stat-grid">
          <div><dt>Sector</dt><dd>${dash(profile.sector)}</dd></div>
          <div><dt>Industry</dt><dd>${dash(profile.industry)}</dd></div>
          <div><dt>Exchange</dt><dd>${dash(profile.exchange)}</dd></div>
          <div><dt>Market cap</dt><dd>${dash(capDisplay)}</dd></div>
          <div><dt>EPS est.</dt><dd>${dash(selected?.epsForecast)}</dd></div>
          <div><dt>Last EPS</dt><dd>${dash(lastEarn ? formatEps(lastEarn.eps) : selected?.lastEpsDisplay || selected?.lastYearEPS)}</dd></div>
          <div><dt>Last surprise</dt><dd>${lastEarn && lastEarn.surprise !== "" && lastEarn.surprise != null ? `${escapeHtml(lastEarn.surprise)}%` : "—"}</dd></div>
          <div><dt>Latest filing</dt><dd>${filingCell || "—"}</dd></div>
          <div><dt>52-week</dt><dd>${dash(profile.week52)}</dd></div>
          <div><dt>Day range</dt><dd>${dash(profile.dayRange)}</dd></div>
          <div><dt>Volume</dt><dd>${dash(profile.volume)}</dd></div>
          <div><dt>Avg volume</dt><dd>${dash(profile.averageVolume)}</dd></div>
          <div><dt>Prev close</dt><dd>${dash(profile.previousClose)}</dd></div>
          <div><dt>1y target</dt><dd>${dash(profile.target)}</dd></div>
        </dl>
      </section>`
      : "";

  els.viewCompany.innerHTML = `
    <button class="back-link" type="button" data-back>← Back to calendar</button>
    <div class="company-hero">
      <div>
        <h2>${escapeHtml(symbol)}</h2>
        <p class="company-hero__name">${escapeHtml(name)}</p>
        <p class="company-hero__meta">${[profile?.exchange, profile?.sector, profile?.industry].filter(Boolean).map(escapeHtml).join(" · ") || "Company snapshot"}</p>
      </div>
      <div class="quote">
        <div class="quote__price">${dash(profile?.price)}</div>
        <div class="quote__chg ${dir}">${chg ? escapeHtml(chg) : ""}</div>
        <p class="quote-asof">${escapeHtml(profile?.asOf || profile?.marketStatus || "")}</p>
      </div>
    </div>
    ${loading}
    ${error}
    ${profile?.description ? `<p class="company-desc">${escapeHtml(profile.description)}</p>` : ""}
    ${website}
    ${overview}
    ${callCards}
    ${history}
    ${filings}
  `;

  els.asOf.textContent = selected ? `Next call ${longDate(selected.date)}` : symbol;
  els.source.textContent = [profile?.exchange, "Nasdaq", profile?.filings?.length ? "SEC EDGAR" : ""]
    .filter(Boolean)
    .join(" · ");
  document.title = `${symbol} — Earnings Calendar`;
}

async function showCompany(symbol, date) {
  const ticker = String(symbol || "").toUpperCase();
  if (!isSymbol(ticker)) {
    els.viewCompany.innerHTML = `<p class="empty">That ticker does not look valid.</p>`;
    return;
  }
  state.companySymbol = ticker;
  state.companyDate = date || "";
  const cached = state.companyCache[ticker];
  renderCompany(ticker, cached || { loading: true });
  if (cached && !cached.loading) {
    hydrateCallsFromProfile(ticker, cached);
    return;
  }
  try {
    const profile = await loadCompanyProfile(ticker);
    state.companyCache[ticker] = profile;
    hydrateCallsFromProfile(ticker, profile);
    if (state.tab === "company" && state.companySymbol === ticker) {
      renderCompany(ticker, profile);
    }
  } catch (err) {
    const fallback = { error: err.message || "Could not load company" };
    if (state.tab === "company" && state.companySymbol === ticker) {
      renderCompany(ticker, fallback);
    }
  }
}

function navCollapsed() {
  return document.documentElement.classList.contains("nav-collapsed");
}

function applyNavCollapsed(collapsed) {
  document.documentElement.classList.toggle("nav-collapsed", collapsed);
  try {
    localStorage.setItem(NAV_STORAGE, JSON.stringify({ collapsed }));
  } catch {}
  if (!els.navToggle) return;
  els.navToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  els.navToggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const label = els.navToggle.querySelector(".sidenav__toggle-text");
  if (label) label.textContent = collapsed ? "Expand" : "Collapse";
  if (els.navLinks) {
    els.navLinks.hidden = collapsed;
    els.navLinks.setAttribute("aria-hidden", collapsed ? "true" : "false");
  }
}

function applyHash() {
  const hash = (location.hash || "#calendar").replace(/^#/, "");
  if (hash === "keys") {
    setView("keys", { updateHash: false });
    return;
  }
  const company = hash.match(/^company\/([A-Za-z0-9.\-]+)(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  if (company) {
    setView("company", {
      symbol: company[1].toUpperCase(),
      date: company[2],
      updateHash: false,
    });
    return;
  }
  setView("calendar", { updateHash: false });
}

function renderWeek(allCalls, filtered) {
  const counts = new Map();
  for (const call of allCalls) {
    counts.set(call.date, (counts.get(call.date) || 0) + 1);
  }
  const days = [...counts.keys()].sort();
  const visible = new Set(filtered.map((c) => c.date));
  els.week.innerHTML = [
    `<button class="day-pill ${state.day === "all" ? "is-on" : ""}" data-day="all" type="button">
      <span class="day-pill__name">All days</span>
      <span class="day-pill__count">${filtered.length}</span>
    </button>`,
    ...days.map((date) => {
      const on = state.day === date ? "is-on" : "";
      const n = filtered.filter((c) => c.date === date).length;
      const faded = visible.has(date) ? "" : ' style="opacity:.45"';
      return `<button class="day-pill ${on}" data-day="${date}" type="button"${faded}>
        <span class="day-pill__name">${shortDate(date)}</span>
        <span class="day-pill__count">${n}</span>
      </button>`;
    }),
  ].join("");
}

function renderBoard(calls) {
  if (!calls.length) {
    els.board.innerHTML = `<p class="empty">No calls match those filters.</p>`;
    return;
  }
  const showRev = calls.some((c) => c.revenueEstimateDisplay);
  els.board.innerHTML = groupByDate(calls)
    .map(([date, rows]) => {
      const body = rows
        .map((call) => {
          const extras = (call.sources || []).filter((s) => s !== "nasdaq");
          const tags = extras
            .map((s) => `<span class="tag">${escapeHtml(SOURCE_LABEL[s] || s)}</span>`)
            .join("");
          return `<tr class="call-row" data-symbol="${escapeHtml(call.symbol)}" data-date="${escapeHtml(call.date)}" tabindex="0" role="link" aria-label="${escapeHtml(call.symbol)} company details">
            <td><span class="time-badge ${call.time}">${TIME_LABEL[call.time]}</span></td>
            <td class="symbol">${escapeHtml(call.symbol)}</td>
            <td>
              <div class="name-link">${escapeHtml(displayName(call.name) || "—")}</div>
              <div class="company hide-sm">${escapeHtml(call.fiscalQuarterEnding || "")}${tags ? ` ${tags}` : ""}</div>
            </td>
            <td class="num">${escapeHtml(call.marketCapDisplay || "—")}</td>
            <td class="num hide-sm">${epsCell(call)}</td>
            ${showRev ? `<td class="num hide-sm">${escapeHtml(call.revenueEstimateDisplay || "—")}</td>` : ""}
            <td class="num hide-sm">${call.estimateCount || "—"}</td>
          </tr>`;
        })
        .join("");
      return `<section class="day-block" id="day-${date}">
        <div class="day-head">
          <h3>${weekday(date)}</h3>
          <span>${longDate(date)} · ${rows.length} call${rows.length === 1 ? "" : "s"}</span>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Ticker</th>
              <th>Company</th>
              <th>Cap</th>
              <th class="hide-sm">EPS est.</th>
              ${showRev ? `<th class="hide-sm">Rev est.</th>` : ""}
              <th class="hide-sm"># est.</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>`;
    })
    .join("");
}

function statusLine(id) {
  const s = state.statuses[id];
  if (!s) {
    return state.keys[id] ? "Saved in this browser" : "Not connected";
  }
  if (s.state === "busy") return "Checking key…";
  if (s.state === "ok") return `Connected · ${s.count} extra row${s.count === 1 ? "" : "s"}`;
  return s.message || "Could not connect";
}

function connectedProviders() {
  return providersByName().filter((provider) => state.keys[provider.id]);
}

function unusedProviders() {
  return providersByName().filter((provider) => !state.keys[provider.id]);
}

function maskKey(value) {
  const key = String(value || "");
  if (key.length <= 4) return "••••";
  return `•••• ${key.slice(-4)}`;
}

function showFormStatus(message, isError = false) {
  if (!els.keyFormStatus) return;
  if (!message) {
    els.keyFormStatus.hidden = true;
    els.keyFormStatus.textContent = "";
    els.keyFormStatus.classList.remove("is-err");
    return;
  }
  els.keyFormStatus.hidden = false;
  els.keyFormStatus.classList.toggle("is-err", isError);
  els.keyFormStatus.textContent = message;
}

function updateKeyHint() {
  const provider = providerById(els.keySource?.value);
  if (!els.keyHint) return;
  if (!provider) {
    els.keyHint.textContent = "Every available source is already connected.";
    return;
  }
  els.keyHint.innerHTML = `${escapeHtml(provider.blurb)}
    <a href="${provider.signup}" target="_blank" rel="noopener">Get a key</a>
    ·
    <a href="${provider.docs}" target="_blank" rel="noopener">API docs</a>`;
}

function renderSourceSelect() {
  const unused = unusedProviders();
  const current = els.keySource.value;
  els.keySource.innerHTML = unused
    .map((provider) => `<option value="${provider.id}">${escapeHtml(provider.name)}</option>`)
    .join("");
  if (unused.some((p) => p.id === current)) els.keySource.value = current;
  const empty = unused.length === 0;
  els.keySource.disabled = empty;
  els.keyValue.disabled = empty;
  const submit = els.keyForm.querySelector("button[type='submit']");
  if (submit) submit.disabled = empty;
  if (empty) els.keyValue.value = "";
  updateKeyHint();
}

function renderKeysPage() {
  renderSourceSelect();
  const saved = connectedProviders();
  if (!saved.length) {
    els.keyList.innerHTML = `<p class="key-list-empty">No extra sources yet. Choose one above to add it.</p>`;
    return;
  }
  els.keyList.innerHTML = saved
    .map((provider) => {
      const s = state.statuses[provider.id];
      const tone = s?.state === "err" ? "is-err" : s?.state === "ok" ? "is-ok" : "";
      return `<article class="key-card" data-provider="${provider.id}">
        <div class="key-card__head">
          <h2>${escapeHtml(provider.name)}</h2>
          <p class="key-status ${tone}">${escapeHtml(statusLine(provider.id))}</p>
        </div>
        <p class="key-links">
          ${escapeHtml(maskKey(state.keys[provider.id]))}
          ·
          <a href="${provider.signup}" target="_blank" rel="noopener">Get a key</a>
          ·
          <a href="${provider.docs}" target="_blank" rel="noopener">API docs</a>
        </p>
        <label class="key-field">
          <span>Update key</span>
          <input
            type="password"
            name="${provider.id}"
            autocomplete="off"
            spellcheck="false"
            placeholder="${escapeHtml(provider.placeholder)}"
            value="${escapeHtml(state.keys[provider.id])}"
          />
        </label>
        <div class="key-actions">
          <button type="button" data-save="${provider.id}">Update</button>
          <button type="button" class="ghost" data-test="${provider.id}">Test</button>
          <button type="button" class="ghost" data-clear="${provider.id}">Remove</button>
        </div>
      </article>`;
    })
    .join("");
}

function pruneDayFilter(today = marketDateIso()) {
  if (state.day !== "all" && state.day < today) state.day = "all";
}

function currentWindow(snap) {
  return windowUpcoming(snap, marketDateIso());
}

function render() {
  pruneDayFilter();
  if (!state.snapshot || state.tab !== "calendar") return;
  const snap = currentWindow(state.snapshot);
  document.title = "Earnings Calendar";
  const filtered = snap.calls.filter(matches);
  const generated = new Date(snap.generatedAt);
  const when = Number.isFinite(generated.getTime())
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      }).format(generated)
    : "just now";
  els.asOf.textContent = `${snap.count} calls · ${snap.startDate} to ${snap.endDate} · updated ${when}`;
  const names = sourceNames(snap);
  els.source.textContent = snap.warning
    ? `${names.join(" · ")} · ${snap.warning}`
    : `${names.join(" · ")}${snap.mode === "live" ? " · live" : " · snapshot"}`;
  const weekCalls = snap.calls.filter((call) => {
    const q = state.query.trim().toLowerCase();
    if (q && !`${call.symbol} ${call.name}`.toLowerCase().includes(q)) return false;
    if (state.time !== "all" && call.time !== state.time) return false;
    if (call.marketCap < state.minCap) return false;
    return true;
  });
  renderWeek(snap.calls, weekCalls);
  renderBoard(filtered);
}

async function loadSnapshot() {
  const res = await fetch("./data/earnings.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.json();
}

async function loadLive() {
  const res = await fetch("/api/earnings?days=21", { cache: "no-store" });
  if (!res.ok) throw new Error(`live ${res.status}`);
  return res.json();
}

async function loadProviderCalls(id, apiKey, from, to) {
  try {
    const res = await fetch(`/api/provider/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, from, to }),
    });
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = await res.json();
      if (res.ok && Array.isArray(payload.calls)) return payload.calls;
      if (res.status !== 404) {
        throw new Error(payload.error || `provider ${res.status}`);
      }
    }
  } catch (err) {
    const msg = err.message || "";
    if (msg && !/Failed to fetch|NetworkError|Unexpected token|JSON/i.test(msg)) {
      throw err;
    }
  }
  return fetchProvider(id, apiKey, { from, to });
}

async function enrichFromKeys(base) {
  const from = base.startDate;
  const to = base.endDate;
  const extras = [];
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      const key = state.keys[provider.id];
      if (!key) {
        delete state.statuses[provider.id];
        return;
      }
      state.statuses[provider.id] = { state: "busy" };
      try {
        const calls = await loadProviderCalls(provider.id, key, from, to);
        extras.push(...calls);
        state.statuses[provider.id] = { state: "ok", count: calls.length };
      } catch (err) {
        state.statuses[provider.id] = {
          state: "err",
          message: err.message || "Request failed",
        };
      }
    })
  );
  if (state.tab === "keys") renderKeysPage();
  if (!extras.length) {
    return {
      ...base,
      calls: (base.calls || []).map((c) => ({
        ...c,
        name: displayName(c.name),
        sources: c.sources?.length ? c.sources : ["nasdaq"],
      })),
      count: base.calls.length,
    };
  }
  const calls = mergeCalls(base.calls, extras);
  return { ...base, count: calls.length, calls };
}

async function applyCalendar(base) {
  const merged = await enrichFromKeys(currentWindow(base));
  const named = {
    ...merged,
    calls: (merged.calls || []).map((c) => ({ ...c, name: displayName(c.name) })),
  };
  named.count = named.calls.length;
  state.snapshot = named;
  if (state.tab === "calendar") render();
  else if (state.tab === "company" && state.companySymbol) {
    showCompany(state.companySymbol, state.companyDate);
  }
  const filled = await enrichSparseCalls(named.calls, {
    onProgress: (calls) => {
      state.snapshot = { ...named, calls, count: calls.length };
      if (state.tab === "calendar") render();
    },
  });
  if (filled === named.calls) return;
  state.snapshot = { ...named, calls: filled, count: filled.length };
  if (state.tab === "calendar") render();
  else if (state.tab === "company" && state.companySymbol) {
    showCompany(state.companySymbol, state.companyDate);
  }
}

async function load() {
  try {
    const raw = await loadSnapshot();
    state.base = { ...currentWindow(raw), mode: raw.mode || "snapshot" };
    await applyCalendar(state.base);
  } catch (err) {
    els.asOf.textContent = "Loading live calendar…";
  }

  try {
    const live = await loadLive();
    state.base = currentWindow(live);
    await applyCalendar(state.base);
  } catch (err) {
    if (!state.snapshot) throw err;
  }
}

document.querySelectorAll("[data-time]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-time]").forEach((b) => b.classList.toggle("is-on", b === btn));
    state.time = btn.dataset.time;
    render();
  });
});

document.querySelectorAll("[data-cap]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-cap]").forEach((b) => b.classList.toggle("is-on", b === btn));
    state.minCap = Number(btn.dataset.cap);
    render();
  });
});


els.board.addEventListener("click", (event) => {
  const row = event.target.closest("[data-symbol]");
  if (!row) return;
  setView("company", { symbol: row.dataset.symbol, date: row.dataset.date });
});

els.board.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("[data-symbol]");
  if (!row) return;
  event.preventDefault();
  setView("company", { symbol: row.dataset.symbol, date: row.dataset.date });
});

els.viewCompany.addEventListener("click", (event) => {
  if (event.target.closest("[data-back]")) setView("calendar");
});

els.week.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-day]");
  if (!btn) return;
  state.day = btn.dataset.day;
  render();
});

els.q.addEventListener("input", () => {
  state.query = els.q.value;
  render();
});

els.keySource.addEventListener("change", updateKeyHint);

els.keyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = els.keySource.value;
  const value = els.keyValue.value.trim();
  const provider = providerById(id);
  if (!provider) {
    showFormStatus("Pick a source from the list.", true);
    return;
  }
  if (!value) {
    showFormStatus("Paste an API key first.", true);
    return;
  }
  state.keys[id] = value;
  saveKeys();
  els.keyValue.value = "";
  showFormStatus(`${provider.name} saved in this browser.`);
  renderKeysPage();
  if (state.base) await applyCalendar(state.base);
  else renderKeysPage();
});

els.keyList.addEventListener("click", async (event) => {
  const saveId = event.target.dataset.save;
  const testId = event.target.dataset.test;
  const clearId = event.target.dataset.clear;
  const id = saveId || testId || clearId;
  if (!id) return;

  if (clearId) {
    state.keys[id] = "";
    delete state.statuses[id];
    saveKeys();
    showFormStatus("");
    renderKeysPage();
    if (state.base) await applyCalendar(state.base);
    return;
  }

  const input = els.keyList.querySelector(`input[name="${id}"]`);
  const value = input?.value.trim() || "";
  if (saveId || testId) {
    if (!value && !state.keys[id]) {
      state.statuses[id] = { state: "err", message: "Paste a key first" };
      renderKeysPage();
      return;
    }
    if (value) state.keys[id] = value;
    if (saveId) saveKeys();
  }
  if (!state.keys[id] || !state.base) {
    renderKeysPage();
    return;
  }
  renderKeysPage();
  await applyCalendar(state.base);
  renderKeysPage();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && state.tab === "calendar" && document.activeElement !== els.q) {
    event.preventDefault();
    els.q.focus();
  }
});

applyHash();
window.addEventListener("hashchange", applyHash);
applyNavCollapsed(navCollapsed());
els.navToggle?.addEventListener("click", () => applyNavCollapsed(!navCollapsed()));

let marketDay = marketDateIso();
let rollingDay = false;

async function onMarketDayChange() {
  const today = marketDateIso();
  if (today === marketDay || rollingDay) return;
  marketDay = today;
  rollingDay = true;
  pruneDayFilter(today);
  try {
    if (state.base) {
      state.base = currentWindow(state.base);
      await applyCalendar(state.base);
    }
    const live = await loadLive();
    state.base = currentWindow(live);
    await applyCalendar(state.base);
  } catch {
    if (state.snapshot) render();
  } finally {
    rollingDay = false;
  }
}

setInterval(onMarketDayChange, 60 * 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") onMarketDayChange();
});
window.addEventListener("focus", onMarketDayChange);

load().catch((err) => {
  els.board.innerHTML = `<p class="empty">Could not load earnings data. ${escapeHtml(err.message)}</p>`;
});
