import { PROVIDERS, fetchProvider, mergeCalls } from "./providers.js";
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
};

const KEYS_STORAGE = "earningsCalendar.apiKeys.v1";

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
  keyCards: document.querySelector("#key-cards"),
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
  document.querySelectorAll(".tab").forEach((btn) => {
    const on = btn.dataset.tab === (tab === "company" ? "calendar" : tab);
    btn.classList.toggle("is-on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  const keysTab = document.querySelector("#tab-keys");
  const n = connectedCount();
  keysTab.textContent = n ? `API keys · ${n}` : "API keys";
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
    renderKeyCards();
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
  if (Number.isFinite(n) && n > 0) {
    if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  }
  return String(value);
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
  const name = profile?.name || selected?.name || symbol;
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

  const callCards = upcoming.length
    ? upcoming
        .map((call) => {
          const extras = (call.sources || []).filter((s) => s !== "nasdaq");
          const tags = extras
            .map((s) => `<span class="tag">${escapeHtml(SOURCE_LABEL[s] || s)}</span>`)
            .join("");
          return `<article class="upcoming-call">
            <h3>${call === selected ? "This call" : "Also on the calendar"}</h3>
            <p><span class="time-badge ${call.time}">${TIME_LABEL[call.time]}</span> · ${longDate(call.date)}${tags}</p>
            <dl class="stat-grid">
              <div><dt>EPS est.</dt><dd>${dash(call.epsForecast)}</dd></div>
              <div><dt>Rev est.</dt><dd>${dash(call.revenueEstimateDisplay)}</dd></div>
              <div><dt>Quarter</dt><dd>${dash(call.fiscalQuarterEnding)}</dd></div>
              <div><dt>Last year EPS</dt><dd>${dash(call.lastYearEPS)}</dd></div>
              <div><dt># estimates</dt><dd>${dash(call.estimateCount || "")}</dd></div>
              <div><dt>Market cap</dt><dd>${dash(call.marketCapDisplay)}</dd></div>
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

  const stats = profile && !profile.loading && (profile.price || profile.sector)
    ? `<dl class="stat-grid">
        <div><dt>Sector</dt><dd>${dash(profile.sector)}</dd></div>
        <div><dt>Industry</dt><dd>${dash(profile.industry)}</dd></div>
        <div><dt>Exchange</dt><dd>${dash(profile.exchange)}</dd></div>
        <div><dt>Market cap</dt><dd>${dash(formatCapLabel(profile.marketCap) === "—" ? selected?.marketCapDisplay : formatCapLabel(profile.marketCap))}</dd></div>
        <div><dt>52-week</dt><dd>${dash(profile.week52)}</dd></div>
        <div><dt>Day range</dt><dd>${dash(profile.dayRange)}</dd></div>
        <div><dt>Volume</dt><dd>${dash(profile.volume)}</dd></div>
        <div><dt>Avg volume</dt><dd>${dash(profile.averageVolume)}</dd></div>
        <div><dt>Prev close</dt><dd>${dash(profile.previousClose)}</dd></div>
        <div><dt>1y target</dt><dd>${dash(profile.target)}</dd></div>
        <div><dt>Dividend</dt><dd>${dash(profile.dividend)}</dd></div>
        <div><dt>Yield</dt><dd>${dash(profile.yield)}</dd></div>
      </dl>`
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
    ${stats}
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
  if (cached && !cached.loading) return;
  try {
    const profile = await loadCompanyProfile(ticker);
    state.companyCache[ticker] = profile;
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
              <div class="name-link">${escapeHtml(call.name || "—")}</div>
              <div class="company hide-sm">${escapeHtml(call.fiscalQuarterEnding || "")}${tags ? ` ${tags}` : ""}</div>
            </td>
            <td class="num">${escapeHtml(call.marketCapDisplay || "—")}</td>
            <td class="num hide-sm">${escapeHtml(call.epsForecast || "—")}</td>
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

function renderKeyCards() {
  els.keyCards.innerHTML = PROVIDERS.map((provider) => {
    const saved = Boolean(state.keys[provider.id]);
    const s = state.statuses[provider.id];
    const tone = s?.state === "err" ? "is-err" : s?.state === "ok" ? "is-ok" : "";
    return `<article class="key-card" data-provider="${provider.id}">
      <div class="key-card__head">
        <h2>${escapeHtml(provider.name)}</h2>
        <p class="key-status ${tone}">${escapeHtml(statusLine(provider.id))}</p>
      </div>
      <p>${escapeHtml(provider.blurb)}</p>
      <p class="key-links">
        <a href="${provider.signup}" target="_blank" rel="noopener">Get a free key</a>
        ·
        <a href="${provider.docs}" target="_blank" rel="noopener">API docs</a>
      </p>
      <label class="key-field">
        <span>API key</span>
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
        <button type="button" data-save="${provider.id}">${saved ? "Update key" : "Save key"}</button>
        <button type="button" class="ghost" data-test="${provider.id}" ${saved ? "" : "disabled"}>Test</button>
        <button type="button" class="ghost" data-clear="${provider.id}" ${saved ? "" : "disabled"}>Remove</button>
      </div>
    </article>`;
  }).join("");
}

function render() {
  const snap = state.snapshot;
  if (!snap || state.tab !== "calendar") return;
  document.title = "Earnings Calendar";
  const filtered = snap.calls.filter(matches);
  const generated = new Date(snap.generatedAt);
  const when = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(generated);
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
  if (state.tab === "keys") renderKeyCards();
  if (!extras.length) {
    return {
      ...base,
      calls: (base.calls || []).map((c) => ({
        ...c,
        sources: c.sources?.length ? c.sources : ["nasdaq"],
      })),
      count: base.calls.length,
    };
  }
  const calls = mergeCalls(base.calls, extras);
  return { ...base, count: calls.length, calls };
}

async function applyCalendar(base) {
  const merged = await enrichFromKeys(base);
  state.snapshot = merged;
  if (state.tab === "calendar") render();
  else if (state.tab === "company" && state.companySymbol) {
    showCompany(state.companySymbol, state.companyDate);
  }
  const filled = await enrichSparseCalls(merged.calls);
  if (filled === merged.calls) return;
  state.snapshot = { ...merged, calls: filled, count: filled.length };
  if (state.tab === "calendar") render();
  else if (state.tab === "company" && state.companySymbol) {
    showCompany(state.companySymbol, state.companyDate);
  }
}

async function load() {
  try {
    state.base = await loadSnapshot();
    state.base.mode = state.base.mode || "snapshot";
    await applyCalendar(state.base);
  } catch (err) {
    els.asOf.textContent = "Loading live calendar…";
  }

  try {
    const live = await loadLive();
    state.base = live;
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

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.tab));
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

els.keyCards.addEventListener("click", async (event) => {
  const saveId = event.target.dataset.save;
  const testId = event.target.dataset.test;
  const clearId = event.target.dataset.clear;
  const id = saveId || testId || clearId;
  if (!id) return;

  if (clearId) {
    state.keys[id] = "";
    delete state.statuses[id];
    saveKeys();
    renderKeyCards();
    if (state.base) {
      await applyCalendar(state.base);
    }
    return;
  }

  const input = els.keyCards.querySelector(`input[name="${id}"]`);
  const value = input?.value.trim() || "";
  if (saveId || testId) {
    if (!value && !state.keys[id]) {
      state.statuses[id] = { state: "err", message: "Paste a key first" };
      renderKeyCards();
      return;
    }
    if (value) state.keys[id] = value;
    if (saveId) saveKeys();
  }
  if (!state.keys[id] || !state.base) {
    renderKeyCards();
    return;
  }
  renderKeyCards();
  await applyCalendar(state.base);
  renderKeyCards();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && state.tab === "calendar" && document.activeElement !== els.q) {
    event.preventDefault();
    els.q.focus();
  }
});

applyHash();
window.addEventListener("hashchange", applyHash);

load().catch((err) => {
  els.board.innerHTML = `<p class="empty">Could not load earnings data. ${escapeHtml(err.message)}</p>`;
});
