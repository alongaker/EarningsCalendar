import { PROVIDERS, OPTIONS_PROVIDERS, allKeyProviders, providersByName, providerById, optionProviderById, fetchProvider, testOratsKey, fetchOratsSnapshot, mergeCalls, rankedIds, reorderIds, formatCompanyName, stripCompanySuffixes, formatEps, formatFiscalPeriod, canonicalSymbol, marketDateIso, windowUpcoming, formatMarketCap, formatMdY, daysUntilIso, formatPctPoints, formatUsdMoney, ORATS_CACHE_HOURS, ORATS_SNAPSHOT_CALLS } from "./providers.js";
import { fetchNasdaqCompany, isSymbol, roundToHundredth, enrichSparseCalls, enrichLastRevenue, enrichCallPrices, hydrateLastRevenue, hydratePrices } from "./company.js";

const TIME_LABEL = {
  "before-open": "Before open",
  "after-close": "After close",
  "during-session": "During session",
  unspecified: "Time TBD",
};

const KEYS_STORAGE = "earningsCalendar.apiKeys.v1";
const ORDER_STORAGE = "earningsCalendar.apiKeyOrder.v1";
const NAV_STORAGE = "earningsCalendar.sidenav.v1";
const ORATS_STORAGE = "earningsCalendar.orats.v1";

const state = {
  base: null,
  snapshot: null,
  query: "",
  time: "all",
  minCap: 50_000_000,
  day: "all",
  tab: "calendar",
  returnTab: "calendar",
  keys: loadKeys(),
  keyOrder: loadKeyOrder(),
  extraCalls: {},
  statuses: {},
  companySymbol: "",
  companyDate: "",
  companyCache: {},
  optionsBySymbol: {},
  sortKey: "",
  sortDir: "desc",
  filtersOpen: false,
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
  viewCompanies: document.querySelector("#view-companies"),
  companiesBoard: document.querySelector("#companies-board"),
  toolbar: document.querySelector("#shared-toolbar"),
  keyForm: document.querySelector("#key-form"),
  keySource: document.querySelector("#key-source"),
  keyValue: document.querySelector("#key-value"),
  keyHint: document.querySelector("#key-hint"),
  keyList: document.querySelector("#key-list"),
  optionsKeyList: document.querySelector("#options-key-list"),
  keyFormStatus: document.querySelector("#key-form-status"),
  navToggle: document.querySelector("#nav-toggle"),
  navKeysText: document.querySelector("#nav-keys-text"),
  navLinks: document.querySelector("#sidenav-nav"),
  pageTitle: document.querySelector("#page-title"),
  filterToggle: document.querySelector("#filter-toggle"),
  filterPanel: document.querySelector("#filter-panel"),
  filterSummary: document.querySelector("#filter-summary"),
};

function loadKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS_STORAGE) || "{}");
    const keys = {};
    for (const provider of allKeyProviders()) {
      keys[provider.id] = String(raw[provider.id] || "").trim();
    }
    return keys;
  } catch {
    return Object.fromEntries(allKeyProviders().map((p) => [p.id, ""]));
  }
}

function saveKeys() {
  localStorage.setItem(KEYS_STORAGE, JSON.stringify(state.keys));
}

function loadKeyOrder() {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_STORAGE) || "[]");
    return Array.isArray(raw) ? raw.map(String) : [];
  } catch {
    return [];
  }
}

function saveKeyOrder() {
  localStorage.setItem(ORDER_STORAGE, JSON.stringify(state.keyOrder));
}

function persistKeyOrder(order) {
  state.keyOrder = rankedIds(
    connectedIds(),
    order
  );
  saveKeyOrder();
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

function matches(call, { ignoreDay = false } = {}) {
  const q = state.query.trim().toLowerCase();
  if (q && !`${call.symbol} ${call.name}`.toLowerCase().includes(q)) return false;
  if (state.time !== "all" && call.time !== state.time) return false;
  if (call.marketCap < state.minCap) return false;
  if (!ignoreDay && state.day !== "all" && call.date !== state.day) return false;
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

function parseMetric(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw || raw === "—" || raw === "-" || /^n\/?a$/i.test(raw)) return null;
  const neg = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[(),$\s,]/g, "");
  const match = cleaned.match(/^(-?[\d.]+)([KMBT])?$/i);
  if (!match) {
    const n = Number(cleaned.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const mul = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[match[2]?.toUpperCase()] || 1;
  return (neg ? -n : n) * mul;
}

function metricValue(call, key) {
  if (key === "cap") {
    const n = Number(call.marketCap);
    return n > 0 ? n : parseMetric(call.marketCapDisplay);
  }
  if (key === "eps") return parseMetric(call.epsForecast);
  if (key === "rev") {
    const n = Number(call.revenueEstimate);
    if (n > 0) return n;
    return parseMetric(call.revenueEstimateDisplay);
  }
  if (key === "lastrev") {
    const n = Number(call.lastRevenue);
    if (n > 0) return n;
    return parseMetric(call.lastRevenueDisplay);
  }
  return null;
}

function sortRows(rows) {
  const key = state.sortKey;
  if (!key) return rows;
  const sign = state.sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = metricValue(a, key);
    const bv = metricValue(b, key);
    if (av == null && bv == null) return a.symbol.localeCompare(b.symbol);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av !== bv) return (av - bv) * sign;
    return a.symbol.localeCompare(b.symbol);
  });
}

function sortHeader(key, label, hideSm = false) {
  const on = state.sortKey === key;
  const arrow = !on ? "" : state.sortDir === "asc" ? " ↑" : " ↓";
  const aria = !on ? "none" : state.sortDir === "asc" ? "ascending" : "descending";
  return `<th class="num${hideSm ? " hide-sm" : ""}" aria-sort="${aria}">
    <button type="button" class="sort-btn ${on ? "is-on" : ""}" data-sort="${key}">${label}${arrow}</button>
  </th>`;
}

function setView(tab, opts = {}) {
  state.tab = tab;
  state.companySymbol = opts.symbol || "";
  state.companyDate = opts.date || "";
  if (tab === "calendar" || tab === "companies") state.returnTab = tab;
  els.viewCalendar.hidden = tab !== "calendar";
  els.viewKeys.hidden = tab !== "keys";
  els.viewCompany.hidden = tab !== "company";
  if (els.viewCompanies) els.viewCompanies.hidden = tab !== "companies";
  if (els.toolbar) els.toolbar.hidden = tab !== "calendar" && tab !== "companies";
  const navTab = tab === "company" ? state.returnTab || "calendar" : tab;
  document.querySelectorAll(".sidenav__link").forEach((link) => {
    const on = link.dataset.nav === navTab;
    link.classList.toggle("is-on", on);
    link.setAttribute("aria-current", on ? "page" : "false");
  });
  const n = connectedCount();
  const optionsOn = OPTIONS_PROVIDERS.some((p) => state.keys[p.id]);
  if (els.navKeysText) els.navKeysText.textContent = "Settings";
  if (els.pageTitle) {
    els.pageTitle.textContent =
      tab === "keys" ? "Settings" : tab === "companies" ? "Companies" : "Earnings Calendar";
  }
  if (tab === "keys") document.title = "Settings — Earnings Calendar";
  else if (tab === "companies") document.title = "Companies — Earnings Calendar";
  if (opts.updateHash !== false) {
    let hash = "#calendar";
    if (tab === "keys") hash = "#keys";
    if (tab === "companies") hash = "#companies";
    if (tab === "company" && state.companySymbol) {
      hash = state.companyDate
        ? `#company/${state.companySymbol}/${state.companyDate}`
        : `#company/${state.companySymbol}`;
    }
    if (location.hash !== hash) history.pushState(null, "", hash);
  }
  if (tab === "keys") {
    const extra = n
      ? `${n} extra provider${n === 1 ? "" : "s"} connected`
      : "No extra calendar providers yet";
    els.asOf.textContent = optionsOn ? `${extra} · ORATS options key saved` : extra;
    els.source.textContent = "Keys stay in this browser";
    renderKeysPage();
  } else if (tab === "company" && state.companySymbol) {
    showCompany(state.companySymbol, state.companyDate);
  } else if (state.snapshot) {
    render();
    if (tab === "companies") fillMissingPrices();
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
  return stripCompanySuffixes(value) || "";
}

function optionCell(value) {
  if (value == null || value === "") return "—";
  return escapeHtml(String(value));
}

function parseSpotPrice(value) {
  const n = Number(String(value || "").replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function formatRank(value) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  const n = Number(value);
  const pct = Math.abs(n) <= 1.5 ? n * 100 : n;
  return `${pct.toFixed(0)}`;
}

function impliedDollarLabel(movePts, spot) {
  if (movePts == null || spot == null) return "";
  return formatUsdMoney(spot * (Number(movePts) / 100));
}

function straddlePctOfSpot(straddle, spot) {
  if (straddle == null || spot == null || !spot) return "";
  return formatPctPoints((Number(straddle) / spot) * 100);
}

function ratioLabel(impliedPts, avgPts) {
  if (impliedPts == null || avgPts == null || !avgPts) return "";
  return `${(Number(impliedPts) / Number(avgPts)).toFixed(2)}×`;
}

function effectLabel(value) {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return `${Number(value).toFixed(2)}×`;
}

function readOratsCache(ticker) {
  const ttl = ORATS_CACHE_HOURS * 60 * 60 * 1000;
  const mem = state.optionsBySymbol[ticker];
  if (mem?.status === "ok" && mem.snapshot && mem.at && Date.now() - mem.at < ttl) {
    return mem.snapshot;
  }
  try {
    const bag = JSON.parse(localStorage.getItem(ORATS_STORAGE) || "{}");
    const hit = bag[ticker];
    if (hit?.at && hit.data && Date.now() - hit.at < ttl) return hit.data;
  } catch {}
  return null;
}

function writeOratsCache(ticker, snapshot) {
  const at = Date.now();
  try {
    const bag = JSON.parse(localStorage.getItem(ORATS_STORAGE) || "{}");
    bag[ticker] = { at, data: snapshot };
    localStorage.setItem(ORATS_STORAGE, JSON.stringify(bag));
  } catch {}
  return at;
}

function tenorRows(snapshot) {
  const rows = snapshot?.tenors || [];
  if (!rows.length) return "";
  return `<section class="history options-block">
    <h3>IV term structure</h3>
    <table class="table">
      <thead>
        <tr>
          <th>Tenor</th>
          <th class="num">IV</th>
          <th class="num">Ex-earnings IV</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `<tr>
              <td>${escapeHtml(row.label)}</td>
              <td class="num">${optionCell(formatPctPoints(row.iv))}</td>
              <td class="num">${optionCell(formatPctPoints(row.exIv))}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  </section>`;
}

function expirationRows(snapshot, spot) {
  const months = [
    ["Front month", snapshot?.front],
    ["Second month", snapshot?.back],
  ].filter(([, m]) => m && (m.dte != null || m.straddle != null || m.atmIv != null));
  if (!months.length) return "";
  return `<section class="history options-block">
    <h3>Listed expirations</h3>
    <table class="table">
      <thead>
        <tr>
          <th></th>
          <th class="num">DTE</th>
          <th class="num">ATM IV</th>
          <th class="num">Straddle</th>
          <th class="num">Straddle / spot</th>
          <th>Strikes</th>
        </tr>
      </thead>
      <tbody>
        ${months
          .map(([label, m]) => {
            const strikes =
              m.loStrike != null && m.hiStrike != null
                ? `${formatUsdMoney(m.loStrike)}–${formatUsdMoney(m.hiStrike)}`
                : "";
            return `<tr>
              <td>${escapeHtml(label)}</td>
              <td class="num">${optionCell(m.dte == null ? "" : String(m.dte))}</td>
              <td class="num">${optionCell(formatPctPoints(m.atmIv))}</td>
              <td class="num">${optionCell(formatUsdMoney(m.straddle))}</td>
              <td class="num">${optionCell(straddlePctOfSpot(m.straddle, spot))}</td>
              <td>${optionCell(strikes)}</td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  </section>`;
}

function historyMoveRows(snapshot) {
  const rows = (snapshot?.history || []).filter((row) => row.date || row.move != null);
  if (!rows.length) return "";
  return `<section class="history options-block">
    <h3>Past earnings moves</h3>
    <table class="table">
      <thead>
        <tr>
          <th>Date</th>
          <th class="num">Actual move</th>
          <th class="num">Straddle then</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `<tr>
              <td>${optionCell(row.date)}</td>
              <td class="num">${optionCell(formatPctPoints(row.move))}</td>
              <td class="num">${optionCell(formatPctPoints(row.straddlePct))}</td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>
  </section>`;
}

function renderOptionsBlock(symbol, profile) {
  if (!state.keys.orats) {
    return `<section class="history options-block">
      <h3>Options</h3>
      <p class="empty">Add an ORATS key in Settings to load implied move, IV rank, straddles, and past earnings moves for this ticker. That uses ${ORATS_SNAPSHOT_CALLS} of 20,000 monthly calls, then caches for ${ORATS_CACHE_HOURS} hours. The Companies list never fetches options.</p>
    </section>`;
  }
  const pack = state.optionsBySymbol[symbol];
  if (!pack || pack.status === "loading") {
    return `<section class="history options-block">
      <h3>Options</h3>
      <p class="status">Loading ORATS delayed options… ${ORATS_SNAPSHOT_CALLS} API calls for this ticker if it is not already cached.</p>
    </section>`;
  }
  if (pack.status === "err") {
    return `<section class="history options-block">
      <h3>Options</h3>
      <p class="empty">${escapeHtml(pack.error || "Could not load ORATS options.")}</p>
    </section>`;
  }
  const snap = pack.snapshot;
  if (!snap) return "";
  const spot = parseSpotPrice(profile?.price);
  const movePts = snap.impliedMove ?? snap.impliedEarningsMove;
  return `<section class="history options-block">
      <h3>Options</h3>
      <p class="options-lede">ORATS delayed snapshot${snap.asOf ? ` · ${escapeHtml(String(snap.asOf).replace("T", " ").slice(0, 16))}` : ""}${pack.cached ? " · from cache" : ""}. ${ORATS_SNAPSHOT_CALLS} calls per ticker, cached ${ORATS_CACHE_HOURS}h in this browser.</p>
      <dl class="stat-grid">
        <div><dt>Implied move</dt><dd>${optionCell(formatPctPoints(movePts))}</dd></div>
        <div><dt>Implied $</dt><dd>${optionCell(impliedDollarLabel(movePts, spot))}</dd></div>
        <div><dt>Avg actual move</dt><dd>${optionCell(formatPctPoints(snap.absAvgErnMv))}</dd></div>
        <div><dt>Implied / avg</dt><dd>${optionCell(ratioLabel(movePts, snap.absAvgErnMv))}</dd></div>
        <div><dt>Earnings effect</dt><dd>${optionCell(effectLabel(snap.ieeEarnEffect))}</dd></div>
        <div><dt>IV 30d</dt><dd>${optionCell(formatPctPoints(snap.iv30d || snap.iv))}</dd></div>
        <div><dt>Ex-earn IV 30d</dt><dd>${optionCell(formatPctPoints(snap.exErnIv30d))}</dd></div>
        <div><dt>IV rank 1y</dt><dd>${optionCell(formatRank(snap.ivRank1y))}</dd></div>
        <div><dt>IV %ile 1y</dt><dd>${optionCell(formatRank(snap.ivPct1y))}</dd></div>
        <div><dt>IV rank 1m</dt><dd>${optionCell(formatRank(snap.ivRank1m))}</dd></div>
        <div><dt>IV %ile 1m</dt><dd>${optionCell(formatRank(snap.ivPct1m))}</dd></div>
        <div><dt>IV crush (earn)</dt><dd>${optionCell(effectLabel(snap.ivEarnReturn))}</dd></div>
        <div><dt>Weeks to call</dt><dd>${optionCell(snap.wksNextErn == null ? "" : Number(snap.wksNextErn).toFixed(1))}</dd></div>
        <div><dt>Last print</dt><dd>${optionCell([snap.lastErn, snap.lastErnTod].filter(Boolean).join(" · "))}</dd></div>
        <div><dt>ORATS next earn</dt><dd>${optionCell(snap.nextErn)}</dd></div>
        <div><dt>Front straddle</dt><dd>${optionCell(formatUsdMoney(snap.front?.straddle))}</dd></div>
      </dl>
    </section>
    ${tenorRows(snap)}
    ${expirationRows(snap, spot)}
    ${historyMoveRows(snap)}`;
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
    if (profile.price && next.price !== profile.price) {
      next.price = profile.price;
      changed = true;
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
          const callCap =
            call.marketCapDisplay && call.marketCapDisplay !== "—"
              ? call.marketCapDisplay
              : capDisplay;
          return `<article class="upcoming-call">
            <h3>${call === selected ? "This call" : "Also on the calendar"}</h3>
            <p><span class="time-badge ${call.time}">${TIME_LABEL[call.time]}</span> · ${longDate(call.date)}</p>
            <dl class="stat-grid">
              <div><dt>EPS est.</dt><dd>${dash(call.epsForecast)}</dd></div>
              <div><dt>Last rev</dt><dd>${dash(call.lastRevenueDisplay)}</dd></div>
              <div><dt>Rev est.</dt><dd>${dash(call.revenueEstimateDisplay)}</dd></div>
              <div><dt>Quarter</dt><dd>${dash(formatFiscalPeriod(call.fiscalQuarterEnding))}</dd></div>
              <div><dt>Last year EPS</dt><dd>${dash(call.lastYearEPS)}</dd></div>
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
          <div><dt>Last rev</dt><dd>${dash(selected?.lastRevenueDisplay)}</dd></div>
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

  const backLabel = state.returnTab === "companies" ? "← Back to companies" : "← Back to calendar";
  els.viewCompany.innerHTML = `
    <button class="back-link" type="button" data-back>${backLabel}</button>
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
    ${renderOptionsBlock(symbol, profile)}
    ${history}
    ${filings}
  `;

  els.asOf.textContent = selected ? `Next call ${longDate(selected.date)}` : symbol;
  els.source.textContent = [profile?.exchange, "Nasdaq", profile?.filings?.length ? "SEC EDGAR" : "", state.keys.orats ? "ORATS" : ""]
    .filter(Boolean)
    .join(" · ");
  document.title = `${symbol} — Earnings Calendar`;
}

async function pingOratsSnapshot(apiKey, ticker) {
  try {
    const res = await fetch("/api/options/orats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, ticker }),
    });
    if (res.status === 404) return fetchOratsSnapshot(apiKey, ticker);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `ORATS ${res.status}`);
    return payload;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    try {
      return await fetchOratsSnapshot(apiKey, ticker);
    } catch {
      throw new Error("Could not reach ORATS. Run npm start locally for options metrics.");
    }
  }
}

async function loadCompanyOptions(ticker) {
  if (state.tab !== "company" || state.companySymbol !== ticker) return;
  if (!state.keys.orats) {
    state.optionsBySymbol[ticker] = { status: "nokey" };
    return;
  }
  const cached = readOratsCache(ticker);
  if (cached) {
    state.optionsBySymbol[ticker] = { status: "ok", snapshot: cached, cached: true, at: Date.now() };
    if (state.tab === "company" && state.companySymbol === ticker) {
      renderCompany(ticker, state.companyCache[ticker] || { loading: true });
    }
    return;
  }
  if (state.optionsBySymbol[ticker]?.status === "loading") return;
  state.optionsBySymbol[ticker] = { status: "loading" };
  if (state.tab === "company" && state.companySymbol === ticker) {
    renderCompany(ticker, state.companyCache[ticker] || { loading: true });
  }
  try {
    const snapshot = await pingOratsSnapshot(state.keys.orats, ticker);
    const at = writeOratsCache(ticker, snapshot);
    state.optionsBySymbol[ticker] = { status: "ok", snapshot, cached: false, at };
  } catch (err) {
    state.optionsBySymbol[ticker] = { status: "err", error: err.message || "Could not load ORATS options." };
  }
  if (state.tab === "company" && state.companySymbol === ticker) {
    renderCompany(ticker, state.companyCache[ticker] || { loading: true });
  }
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
  void loadCompanyOptions(ticker);
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
  if (hash === "companies") {
    setView("companies", { updateHash: false });
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
  els.board.innerHTML = groupByDate(calls)
    .map(([date, rows]) => {
      const body = sortRows(rows)
        .map((call) => {
          return `<tr class="call-row" data-symbol="${escapeHtml(call.symbol)}" data-date="${escapeHtml(call.date)}" tabindex="0" role="link" aria-label="${escapeHtml(call.symbol)} company details">
            <td><span class="time-badge ${call.time}">${TIME_LABEL[call.time]}</span></td>
            <td class="symbol">${escapeHtml(call.symbol)}</td>
            <td>
              <div class="name-link">${escapeHtml(displayName(call.name) || "—")}</div>
              <div class="company hide-sm">${escapeHtml(formatFiscalPeriod(call.fiscalQuarterEnding))}</div>
            </td>
            <td class="num">${escapeHtml(call.marketCapDisplay || "—")}</td>
            <td class="num hide-sm">${escapeHtml(call.lastRevenueDisplay || "—")}</td>
            <td class="num hide-sm">${escapeHtml(call.revenueEstimateDisplay || "—")}</td>
            <td class="num hide-sm">${epsCell(call)}</td>
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
              ${sortHeader("cap", "Cap", false)}
              ${sortHeader("lastrev", "Last rev", true)}
              ${sortHeader("rev", "Rev est.", true)}
              ${sortHeader("eps", "EPS est.", true)}
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
  const options = optionProviderById(id);
  if (!s) {
    if (options) return state.keys[id] ? "Saved in this browser" : "Paste a token to connect";
    return state.keys[id] ? "Saved in this browser" : "Not connected";
  }
  if (s.state === "busy") return "Checking key…";
  if (s.state === "ok") {
    if (options) return s.message || "Connected · ORATS key works";
    return `Connected · ${s.count} extra row${s.count === 1 ? "" : "s"}`;
  }
  return s.message || "Could not connect";
}

function connectedIds() {
  return providersByName()
    .filter((provider) => state.keys[provider.id])
    .map((provider) => provider.id);
}

function connectedProviders() {
  return rankedIds(connectedIds(), state.keyOrder)
    .map((id) => providerById(id))
    .filter(Boolean);
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

function optionsKeyCard(provider) {
  const id = provider.id;
  const s = state.statuses[id];
  const tone = s?.state === "err" ? "is-err" : s?.state === "ok" ? "is-ok" : "";
  const saved = Boolean(state.keys[id]);
  return `<article class="key-card key-card--fixed" data-options-provider="${id}">
    <div class="key-card__body">
      <div class="key-card__head">
        <h2>${escapeHtml(provider.name)}</h2>
        <p class="key-status ${tone}" title="${escapeHtml(statusLine(id))}">${escapeHtml(statusLine(id))}</p>
      </div>
      <p class="key-hint">${escapeHtml(provider.blurb)}</p>
      <div class="key-card__row">
        <p class="key-links">
          ${saved ? `${escapeHtml(maskKey(state.keys[id]))} · ` : ""}
          <a href="${provider.signup}" target="_blank" rel="noopener">Get a token</a>
          ·
          <a href="${provider.docs}" target="_blank" rel="noopener">API docs</a>
        </p>
        <input
          type="password"
          name="${id}"
          autocomplete="off"
          spellcheck="false"
          aria-label="${escapeHtml(provider.name)} options API key"
          placeholder="${escapeHtml(provider.placeholder)}"
          value="${escapeHtml(state.keys[id])}"
        />
        <div class="key-actions">
          <button type="button" data-options-save="${id}">${saved ? "Update" : "Save"}</button>
          <button type="button" class="ghost" data-options-test="${id}">Test</button>
          <button type="button" class="ghost" data-options-clear="${id}" ${saved ? "" : "disabled"}>Remove</button>
        </div>
      </div>
    </div>
  </article>`;
}

function renderOptionsKeys() {
  if (!els.optionsKeyList) return;
  els.optionsKeyList.innerHTML = OPTIONS_PROVIDERS.map(optionsKeyCard).join("");
}

function renderKeysPage() {
  renderSourceSelect();
  renderOptionsKeys();
  const saved = connectedProviders();
  if (!saved.length) {
    els.keyList.innerHTML = `<p class="key-list-empty">No extra sources yet. Choose one above to add it.</p>`;
    return;
  }
  els.keyList.innerHTML = saved
    .map((provider, index) => {
      const s = state.statuses[provider.id];
      const tone = s?.state === "err" ? "is-err" : s?.state === "ok" ? "is-ok" : "";
      const rank = index + 1;
      return `<article class="key-card" data-provider="${provider.id}" draggable="true">
        <button
          type="button"
          class="key-card__handle"
          data-rank-handle="${provider.id}"
          draggable="true"
          aria-label="${escapeHtml(provider.name)} priority ${rank}. Drag or use arrow keys to reorder"
          title="Drag to rank"
        >${rank}</button>
        <div class="key-card__body">
          <div class="key-card__head">
            <h2>${escapeHtml(provider.name)}</h2>
            <p class="key-status ${tone}" title="${escapeHtml(statusLine(provider.id))}">${escapeHtml(statusLine(provider.id))}</p>
          </div>
          <div class="key-card__row">
            <p class="key-links">
              ${escapeHtml(maskKey(state.keys[provider.id]))}
              ·
              <a href="${provider.signup}" target="_blank" rel="noopener">Get a key</a>
              ·
              <a href="${provider.docs}" target="_blank" rel="noopener">API docs</a>
            </p>
            <input
              type="password"
              name="${provider.id}"
              draggable="false"
              autocomplete="off"
              spellcheck="false"
              aria-label="Update ${escapeHtml(provider.name)} key"
              placeholder="${escapeHtml(provider.placeholder)}"
              value="${escapeHtml(state.keys[provider.id])}"
            />
            <div class="key-actions">
              <button type="button" data-save="${provider.id}">Update</button>
              <button type="button" class="ghost" data-test="${provider.id}">Test</button>
              <button type="button" class="ghost" data-clear="${provider.id}">Remove</button>
            </div>
          </div>
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

function renderCompanies(calls) {
  if (!els.companiesBoard) return;
  if (!calls.length) {
    els.companiesBoard.innerHTML = `<p class="empty">No calls match those filters.</p>`;
    return;
  }
  const today = marketDateIso();
  const rows = [...calls].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.symbol.localeCompare(b.symbol);
  });
  const body = rows
    .map((call) => {
      const days = daysUntilIso(call.date, today);
      const daysLabel = days == null ? "—" : String(days);
      return `<div class="call-row" data-symbol="${escapeHtml(call.symbol)}" data-date="${escapeHtml(call.date)}" tabindex="0" role="link" aria-label="${escapeHtml(call.symbol)} company details">
        <div class="companies-pin">
          <span class="symbol">${escapeHtml(call.symbol)}</span>
          <span class="company-clip" title="${escapeHtml(displayName(call.name) || "—")}">${escapeHtml(displayName(call.name) || "—")}</span>
        </div>
        <div class="num">${escapeHtml(formatMdY(call.date) || "—")}</div>
        <div class="num">${escapeHtml(daysLabel)}</div>
        <div class="num">${dash(call.price)}</div>
        <div class="num">${escapeHtml(call.marketCapDisplay || "—")}</div>
      </div>`;
    })
    .join("");
  els.companiesBoard.innerHTML = `<section class="day-block">
    <div class="day-head">
      <h3>Upcoming</h3>
      <span>${rows.length} compan${rows.length === 1 ? "y" : "ies"}</span>
    </div>
    <div class="companies-scroll">
    <div class="companies-grid">
      <div class="companies-grid__head">
        <div class="companies-pin">
          <span>Ticker</span>
          <span>Company</span>
        </div>
        <div class="num">Date</div>
        <div class="num">Until Call</div>
        <div class="num">Price</div>
        <div class="num">Market cap</div>
      </div>
      ${body}
    </div>
    </div>
  </section>`;
}

function render() {
  pruneDayFilter();
  if (!state.snapshot) return;
  if (state.tab !== "calendar" && state.tab !== "companies") return;
  const snap = currentWindow(state.snapshot);
  const listRows = snap.calls.filter((call) => matches(call, { ignoreDay: true }));
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
  if (state.tab === "companies") {
    document.title = "Companies — Earnings Calendar";
    els.asOf.textContent = `${listRows.length} companies · ${snap.startDate} to ${snap.endDate} · updated ${when}`;
    els.source.textContent = snap.warning
      ? snap.warning
      : snap.mode === "live"
        ? "Live calendar"
        : "Saved snapshot";
    renderCompanies(listRows);
    syncFilterBar();
    return;
  }
  document.title = "Earnings Calendar";
  const filtered = snap.calls.filter(matches);
  els.asOf.textContent = `${snap.count} calls · ${snap.startDate} to ${snap.endDate} · updated ${when}`;
  els.source.textContent = snap.warning
    ? snap.warning
    : snap.mode === "live"
      ? "Live calendar"
      : "Saved snapshot";
  const weekCalls = listRows;
  renderWeek(snap.calls, weekCalls);
  renderBoard(filtered);
  syncFilterBar();
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

function mergeCachedExtras(base) {
  const extras = connectedProviders().flatMap((provider) => state.extraCalls[provider.id] || []);
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

async function enrichFromKeys(base) {
  const from = base.startDate;
  const to = base.endDate;
  await Promise.all(
    PROVIDERS.map(async (provider) => {
      const key = state.keys[provider.id];
      if (!key) {
        delete state.statuses[provider.id];
        delete state.extraCalls[provider.id];
        return;
      }
      state.statuses[provider.id] = { state: "busy" };
      try {
        const calls = await loadProviderCalls(provider.id, key, from, to);
        state.extraCalls[provider.id] = calls;
        state.statuses[provider.id] = { state: "ok", count: calls.length };
      } catch (err) {
        delete state.extraCalls[provider.id];
        state.statuses[provider.id] = {
          state: "err",
          message: err.message || "Request failed",
        };
      }
    })
  );
  if (state.tab === "keys") renderKeysPage();
  return mergeCachedExtras(base);
}

function carryMetrics(calls) {
  const prev = new Map((state.snapshot?.calls || []).map((call) => [call.symbol, call]));
  return (calls || []).map((call) => {
    const prior = prev.get(call.symbol);
    if (!prior) return call;
    const hasRevEst = String(call.revenueEstimateDisplay || "").trim();
    const hasLast = call.lastRevenue || String(call.lastRevenueDisplay || "").trim();
    const hasPrice = String(call.price || "").trim();
    return {
      ...call,
      lastRevenue: hasLast ? call.lastRevenue : prior.lastRevenue || 0,
      lastRevenueDisplay: hasLast ? call.lastRevenueDisplay : prior.lastRevenueDisplay || "",
      revenueEstimate: hasRevEst ? call.revenueEstimate : prior.revenueEstimate || 0,
      revenueEstimateDisplay: hasRevEst ? call.revenueEstimateDisplay : prior.revenueEstimateDisplay || "",
      price: hasPrice ? call.price : prior.price || "",
    };
  });
}

let pricesBusy = false;
let pricesQueued = false;

async function fillMissingPrices() {
  if (!state.snapshot) return;
  if (pricesBusy) {
    pricesQueued = true;
    return;
  }
  const calls = state.snapshot.calls || [];
  if (!calls.some((call) => !String(call.price || "").trim() || call.price === "—")) return;
  pricesBusy = true;
  pricesQueued = false;
  try {
    const next = await enrichCallPrices(calls, {
      onProgress: (updated) => {
        state.snapshot = { ...state.snapshot, calls: updated, count: updated.length };
        if (state.tab === "companies" || state.tab === "calendar") render();
      },
    });
    state.snapshot = { ...state.snapshot, calls: next, count: next.length };
    if (state.tab === "companies" || state.tab === "calendar") render();
  } finally {
    pricesBusy = false;
    if (pricesQueued) fillMissingPrices();
  }
}

async function applyCalendar(base, { refreshKeys = true } = {}) {
  const windowed = currentWindow(base);
  const merged = refreshKeys ? await enrichFromKeys(windowed) : mergeCachedExtras(windowed);
  const named = {
    ...merged,
    calls: hydratePrices(hydrateLastRevenue(carryMetrics(merged.calls || []))).map((c) => ({
      ...c,
      name: displayName(c.name),
    })),
  };
  named.count = named.calls.length;
  state.snapshot = named;
  if (state.tab === "calendar" || state.tab === "companies") render();
  else if (state.tab === "company" && state.companySymbol) {
    showCompany(state.companySymbol, state.companyDate);
  }
  const filled = await enrichSparseCalls(named.calls, {
    onProgress: (calls) => {
      state.snapshot = { ...named, calls, count: calls.length };
      if (state.tab === "calendar" || state.tab === "companies") render();
    },
  });
  const withRev = await enrichLastRevenue(filled, {
    onProgress: (calls) => {
      state.snapshot = { ...named, calls, count: calls.length };
      if (state.tab === "calendar" || state.tab === "companies") render();
    },
  });
  state.snapshot = { ...named, calls: withRev, count: withRev.length };
  if (state.tab === "calendar" || state.tab === "companies") render();
  else if (state.tab === "company" && state.companySymbol) {
    showCompany(state.companySymbol, state.companyDate);
  }
  await fillMissingPrices();
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

const CAP_LABEL = {
  50000000: "$50M+",
  100000000: "$100M+",
  250000000: "$250M+",
  500000000: "$500M+",
  1000000000: "$1B+",
  10000000000: "$10B+",
  100000000000: "$100B+",
};

function filterSummaryText() {
  const parts = [];
  const q = state.query.trim();
  if (q) parts.push(q);
  if (state.time !== "all") parts.push(TIME_LABEL[state.time] || state.time);
  if (CAP_LABEL[state.minCap]) parts.push(CAP_LABEL[state.minCap]);
  return parts.join(" · ");
}

function syncFilterBar() {
  if (!els.filterToggle) return;
  if (els.filterSummary) els.filterSummary.textContent = filterSummaryText();
  els.filterToggle.setAttribute("aria-expanded", state.filtersOpen ? "true" : "false");
  if (els.filterPanel) els.filterPanel.hidden = !state.filtersOpen;
}

function setFiltersOpen(open, { focusSearch = false } = {}) {
  state.filtersOpen = Boolean(open);
  syncFilterBar();
  if (focusSearch && state.filtersOpen) els.q?.focus();
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


els.companiesBoard?.addEventListener("click", (event) => {
  const row = event.target.closest("[data-symbol]");
  if (!row) return;
  setView("company", { symbol: row.dataset.symbol, date: row.dataset.date });
});

els.companiesBoard?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const row = event.target.closest("[data-symbol]");
  if (!row) return;
  event.preventDefault();
  setView("company", { symbol: row.dataset.symbol, date: row.dataset.date });
});

els.board.addEventListener("click", (event) => {
  const sortBtn = event.target.closest("[data-sort]");
  if (sortBtn) {
    const key = sortBtn.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
    } else {
      state.sortKey = key;
      state.sortDir = "desc";
    }
    render();
    return;
  }
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
  if (event.target.closest("[data-back]")) setView(state.returnTab || "calendar");
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

els.filterToggle?.addEventListener("click", () => setFiltersOpen(!state.filtersOpen));

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
  persistKeyOrder([...state.keyOrder, id]);
  els.keyValue.value = "";
  showFormStatus(`${provider.name} saved in this browser.`);
  renderKeysPage();
  if (state.base) await applyCalendar(state.base);
  else renderKeysPage();
});

let dragProvider = "";

function dropIndexAt(clientY) {
  const others = [...els.keyList.querySelectorAll(".key-card")].filter(
    (card) => card.dataset.provider !== dragProvider
  );
  for (let i = 0; i < others.length; i++) {
    const rect = others[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return others.length;
}

function paintDropTarget(index) {
  const others = [...els.keyList.querySelectorAll(".key-card")].filter(
    (card) => card.dataset.provider !== dragProvider
  );
  others.forEach((card, i) => card.classList.toggle("is-drop-before", i === index));
  els.keyList.classList.toggle("is-drop-end", index === others.length && others.length > 0);
}

async function commitKeyOrder(order) {
  persistKeyOrder(order);
  renderKeysPage();
  if (state.base) await applyCalendar(state.base, { refreshKeys: false });
}

els.keyList.addEventListener("dragstart", (event) => {
  if (event.target.closest("input, a, [data-save], [data-test], [data-clear]")) {
    event.preventDefault();
    return;
  }
  const card = event.target.closest(".key-card");
  if (!card) {
    event.preventDefault();
    return;
  }
  dragProvider = card.dataset.provider;
  card.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", dragProvider);
});

els.keyList.addEventListener("dragover", (event) => {
  if (!dragProvider) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  paintDropTarget(dropIndexAt(event.clientY));
});

els.keyList.addEventListener("drop", async (event) => {
  if (!dragProvider) return;
  event.preventDefault();
  const fromId = dragProvider;
  const ids = connectedProviders().map((provider) => provider.id);
  const next = reorderIds(ids, fromId, dropIndexAt(event.clientY));
  dragProvider = "";
  els.keyList.classList.remove("is-drop-end");
  await commitKeyOrder(next);
});

els.keyList.addEventListener("dragend", () => {
  dragProvider = "";
  els.keyList.classList.remove("is-drop-end");
  els.keyList.querySelectorAll(".key-card").forEach((card) => {
    card.classList.remove("is-dragging", "is-drop-before");
  });
});

els.keyList.addEventListener("keydown", async (event) => {
  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
  if (!event.target.closest("[data-rank-handle]")) return;
  const card = event.target.closest(".key-card");
  if (!card) return;
  event.preventDefault();
  const ids = connectedProviders().map((provider) => provider.id);
  const from = ids.indexOf(card.dataset.provider);
  if (from < 0) return;
  const nextIndex = event.key === "ArrowUp" ? from - 1 : from + 1;
  if (nextIndex < 0 || nextIndex >= ids.length) return;
  await commitKeyOrder(reorderIds(ids, card.dataset.provider, nextIndex));
  const handle = els.keyList.querySelector(`[data-rank-handle="${card.dataset.provider}"]`);
  handle?.focus();
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
    delete state.extraCalls[id];
    saveKeys();
    persistKeyOrder(state.keyOrder.filter((item) => item !== id));
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

async function pingOratsKey(apiKey) {
  try {
    const res = await fetch("/api/options/orats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    if (res.status === 404) return testOratsKey(apiKey);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `ORATS ${res.status}`);
    return payload;
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    try {
      return await testOratsKey(apiKey);
    } catch {
      throw new Error("Could not reach ORATS. Run npm start locally to test this key.");
    }
  }
}

els.optionsKeyList?.addEventListener("click", async (event) => {
  const saveId = event.target.dataset.optionsSave;
  const testId = event.target.dataset.optionsTest;
  const clearId = event.target.dataset.optionsClear;
  const id = saveId || testId || clearId;
  if (!id || !optionProviderById(id)) return;

  if (clearId) {
    state.keys[id] = "";
    delete state.statuses[id];
    saveKeys();
    showFormStatus("ORATS options key removed from this browser.");
    renderKeysPage();
    return;
  }

  const input = els.optionsKeyList.querySelector(`input[name="${id}"]`);
  const value = input?.value.trim() || "";
  if (!value && !state.keys[id]) {
    state.statuses[id] = { state: "err", message: "Paste a token first" };
    renderKeysPage();
    return;
  }
  if (value) state.keys[id] = value;
  if (saveId) {
    saveKeys();
    showFormStatus("ORATS options key saved in this browser.");
    state.statuses[id] = { state: "ok", message: "Saved in this browser" };
    renderKeysPage();
    return;
  }

  saveKeys();
  state.statuses[id] = { state: "busy" };
  renderKeysPage();
  try {
    await pingOratsKey(state.keys[id]);
    state.statuses[id] = { state: "ok", message: "Connected · ORATS key works" };
    showFormStatus("ORATS options key works.");
  } catch (err) {
    state.statuses[id] = { state: "err", message: err.message || "Could not connect" };
    showFormStatus(err.message || "ORATS test failed.", true);
  }
  renderKeysPage();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && (state.tab === "calendar" || state.tab === "companies") && document.activeElement !== els.q) {
    event.preventDefault();
    setFiltersOpen(true, { focusSearch: true });
    return;
  }
  if (event.key === "Escape" && (state.tab === "calendar" || state.tab === "companies") && state.filtersOpen) {
    event.preventDefault();
    setFiltersOpen(false);
    els.filterToggle?.focus();
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
