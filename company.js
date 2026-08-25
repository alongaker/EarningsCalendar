import { formatCompanyName, formatEps, canonicalSymbol, parseMarketCap, formatMarketCap, keepCalendarRow, isPlaceholderName } from "./providers.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function isSymbol(value) {
  return /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(String(value || "").trim());
}

function groupThousands(whole) {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function roundToHundredth(value) {
  if (value === null || value === undefined || value === "") return value ?? "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value;
    const frac = String(value).split(".")[1];
    if (!frac || frac.length <= 2) return value;
    return Number(value.toFixed(2));
  }
  return String(value).replace(/(-?)(\d{1,3}(?:,\d{3})*|\d+)\.(\d+)/g, (full, sign, intPart, frac) => {
    if (frac.length <= 2) return full;
    const n = Number(`${sign}${intPart.replace(/,/g, "")}.${frac}`);
    if (!Number.isFinite(n)) return full;
    const rounded = Math.abs(n).toFixed(2);
    const [whole, decimals] = rounded.split(".");
    const grouped = intPart.includes(",") ? groupThousands(whole) : whole;
    return `${n < 0 ? "-" : ""}${grouped}.${decimals}`;
  });
}

function val(field) {
  if (field === null || field === undefined) return "";
  if (typeof field === "object") return roundToHundredth(field.value ?? field.label ?? "");
  return roundToHundredth(String(field));
}

async function nasdaqJson(path, { fetchImpl = fetch } = {}) {
  const url = path.startsWith("http") ? path : `https://api.nasdaq.com${path}`;
  const res = await fetchImpl(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json,text/plain,*/*",
      Origin: "https://www.nasdaq.com",
      Referer: "https://www.nasdaq.com/",
    },
  });
  const payload = await res.json();
  if (!res.ok || payload?.status?.rCode >= 400 || !payload?.data) {
    const msg =
      payload?.status?.bCodeMessage?.[0]?.errorMessage ||
      payload?.message ||
      `Nasdaq ${res.status}`;
    throw new Error(msg);
  }
  return payload.data;
}

export function normalizeCompany({ info, summary, profile, surprises } = {}) {
  const primary = info?.primaryData || {};
  const stats = info?.keyStats || {};
  const summaryData = summary?.summaryData || {};
  const history = surprises?.earningsSurpriseTable?.rows || [];
  return {
    symbol: (info?.symbol || profile?.Symbol?.value || "").toUpperCase(),
    name: formatCompanyName(val(profile?.CompanyName) || info?.companyName || ""),
    exchange: info?.exchange || val(summaryData.Exchange),
    stockType: info?.stockType || "",
    marketStatus: info?.marketStatus || "",
    price: roundToHundredth(primary.lastSalePrice || ""),
    netChange: roundToHundredth(primary.netChange || ""),
    percentageChange: roundToHundredth(primary.percentageChange || ""),
    direction: primary.deltaIndicator || "",
    asOf: primary.lastTradeTimestamp || "",
    bid: roundToHundredth(primary.bidPrice || ""),
    ask: roundToHundredth(primary.askPrice || ""),
    volume: roundToHundredth(val(summaryData.ShareVolume) || primary.volume || ""),
    averageVolume: roundToHundredth(val(summaryData.AverageVolume)),
    previousClose: roundToHundredth(val(summaryData.PreviousClose)),
    dayRange: roundToHundredth(val(stats.dayrange) || val(summaryData.TodayHighLow)),
    week52: roundToHundredth(val(stats.fiftyTwoWeekHighLow) || val(summaryData.FiftTwoWeekHighLow)),
    marketCap: roundToHundredth(val(summaryData.MarketCap)),
    target: roundToHundredth(val(summaryData.OneYrTarget)),
    dividend: roundToHundredth(val(summaryData.AnnualizedDividend)),
    yield: roundToHundredth(val(summaryData.Yield)),
    exDividend: val(summaryData.ExDividendDate),
    sector: val(profile?.Sector) || val(summaryData.Sector),
    industry: val(profile?.Industry) || val(summaryData.Industry),
    region: val(profile?.Region),
    website: val(profile?.CompanyUrl),
    description: val(profile?.CompanyDescription),
    earningsHistory: history.map((row) => ({
      fiscalQtrEnd: row.fiscalQtrEnd || "",
      dateReported: row.dateReported || "",
      eps: roundToHundredth(row.eps ?? ""),
      consensus: roundToHundredth(row.consensusForecast || ""),
      surprise: roundToHundredth(row.percentageSurprise || ""),
    })),
  };
}

export async function fetchNasdaqCompany(symbol, { fetchImpl = fetch } = {}) {
  const ticker = String(symbol || "").trim().toUpperCase().replace(/-/g, ".");
  if (!isSymbol(ticker)) throw new Error("Invalid symbol");

  const classes = ["stocks", "etf"];
  let info = null;
  let lastErr = null;
  for (const assetclass of classes) {
    try {
      info = await nasdaqJson(
        `/api/quote/${encodeURIComponent(ticker)}/info?assetclass=${assetclass}`,
        { fetchImpl }
      );
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!info) throw lastErr || new Error("Symbol not found");

  const [summary, profile, surprises] = await Promise.all([
    nasdaqJson(`/api/quote/${encodeURIComponent(ticker)}/summary?assetclass=${(info.assetClass || "stocks").toLowerCase()}`, {
      fetchImpl,
    }).catch(() => null),
    nasdaqJson(`/api/company/${encodeURIComponent(ticker)}/company-profile`, { fetchImpl }).catch(
      () => null
    ),
    nasdaqJson(`/api/company/${encodeURIComponent(ticker)}/earnings-surprise`, { fetchImpl }).catch(
      () => null
    ),
  ]);

  return normalizeCompany({ info, summary, profile, surprises });
}

const quoteCache = new Map();
const tickerMapCache = { at: 0, map: null };
const SEC_UA =
  (typeof process !== "undefined" && process.env && process.env.SEC_USER_AGENT) ||
  "Earnings Calendar alongaker21@gmail.com";
const EDGAR_FORMS = new Set([
  "8-K",
  "8-K/A",
  "10-Q",
  "10-Q/A",
  "10-K",
  "10-K/A",
  "6-K",
  "20-F",
  "20-F/A",
  "40-F",
  "DEF 14A",
  "S-1",
]);

export async function fetchNasdaqQuoteLite(symbol, { fetchImpl = fetch, withEps = false } = {}) {
  const ticker = String(symbol || "").trim().toUpperCase().replace(/-/g, ".");
  if (!isSymbol(ticker)) return null;
  const hit = quoteCache.get(ticker);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
    if (!hit.data || !withEps || hit.data.epsChecked) return hit.data;
    const extra = await fetchLastEps(ticker, fetchImpl);
    const data = { ...hit.data, ...extra, epsChecked: true };
    quoteCache.set(ticker, { at: hit.at, data });
    return data;
  }

  let info = null;
  for (const assetclass of ["stocks", "etf"]) {
    try {
      info = await nasdaqJson(
        `/api/quote/${encodeURIComponent(ticker)}/info?assetclass=${assetclass}`,
        { fetchImpl }
      );
      break;
    } catch {
      info = null;
    }
  }
  if (!info) {
    quoteCache.set(ticker, { at: Date.now(), data: null });
    return null;
  }
  let summary = null;
  try {
    summary = await nasdaqJson(
      `/api/quote/${encodeURIComponent(ticker)}/summary?assetclass=${(info.assetClass || "stocks").toLowerCase()}`,
      { fetchImpl }
    );
  } catch {
    summary = null;
  }
  const capRaw = val(summary?.summaryData?.MarketCap);
  const marketCap = parseMarketCap(capRaw);
  let data = {
    symbol: ticker,
    name: formatCompanyName((info.companyName || "").replace(/\s+Common Stock$/i, "")),
    price: val(info?.primaryData?.lastSalePrice),
    marketCap,
    marketCapDisplay: formatMarketCap(marketCap),
    lastEpsDisplay: "",
    epsChecked: false,
  };
  if (withEps) {
    data = { ...data, ...(await fetchLastEps(ticker, fetchImpl)), epsChecked: true };
  }
  quoteCache.set(ticker, { at: Date.now(), data });
  return data;
}

async function fetchLastEps(ticker, fetchImpl) {
  try {
    const surprises = await nasdaqJson(
      `/api/company/${encodeURIComponent(ticker)}/earnings-surprise`,
      { fetchImpl }
    );
    const row = surprises?.earningsSurpriseTable?.rows?.[0];
    if (!row) return { lastEpsDisplay: "" };
    const eps = formatEps(row.eps);
    const consensus = formatEps(row.consensusForecast);
    return {
      lastEpsDisplay: eps,
      lastConsensusDisplay: consensus,
    };
  } catch {
    return { lastEpsDisplay: "" };
  }
}

function applyQuotes(calls, quotes) {
  return calls.map((call) => {
    const quote = quotes.get(call.symbol) || quotes.get(canonicalSymbol(call.symbol));
    const name = formatCompanyName(call.name || quote?.name || "");
    if (!quote || quote.missing) {
      const next = {
        ...call,
        name,
        unlisted: Boolean(quote?.missing) && isPlaceholderName(name, call.symbol),
      };
      return next.name !== call.name || next.unlisted !== call.unlisted ? next : call;
    }
    const marketCap = call.marketCap || quote.marketCap || 0;
    return {
      ...call,
      name: name || call.name,
      price: nonemptyField(call.price) ? call.price : quote.price || "",
      marketCap,
      marketCapDisplay: call.marketCap ? call.marketCapDisplay : quote.marketCapDisplay || "—",
      lastEpsDisplay: call.lastEpsDisplay || quote.lastEpsDisplay || "",
      unlisted: false,
    };
  });
}

export function parseRevenueCell(value) {
  const s = String(value || "").trim();
  if (!s || /^(n\/?a|na|none|null|-|—)$/i.test(s)) return 0;
  const match = s.replace(/,/g, "").match(/^\$?\(?(-?[\d.]+)\)?\s*(?:\(([kmbt])\))?$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n === 0) return 0;
  const mul = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2]?.toLowerCase()] || 1;
  return Math.abs(n) * mul;
}

export function lastQuarterRevenueFromTable(table) {
  const rows = table?.rows || [];
  let last = 0;
  for (const row of rows) {
    const label = String(row.value1 || "").trim();
    if (/^totals$/i.test(label)) break;
    if (!/^revenue$/i.test(label)) continue;
    const current = parseRevenueCell(row.value2);
    if (current) last = current;
  }
  if (last) return last;
  for (let i = rows.length - 1; i >= 0; i--) {
    const label = String(rows[i].value1 || "").trim();
    if (/^totals$/i.test(label) || !/^revenue$/i.test(label)) continue;
    const prior = parseRevenueCell(rows[i].value3) || parseRevenueCell(rows[i].value2);
    if (prior) return prior;
  }
  return 0;
}

export async function fetchLastQuarterRevenue(symbol, { fetchImpl = fetch } = {}) {
  const ticker = canonicalSymbol(symbol);
  if (!isSymbol(ticker)) return { lastRevenue: 0, lastRevenueDisplay: "" };
  try {
    const data = await nasdaqJson(`/api/company/${encodeURIComponent(ticker)}/revenue`, {
      fetchImpl,
    });
    const lastRevenue = lastQuarterRevenueFromTable(data?.revenueTable);
    return {
      lastRevenue,
      lastRevenueDisplay: lastRevenue ? formatMarketCap(lastRevenue) : "",
    };
  } catch {
    return { lastRevenue: 0, lastRevenueDisplay: "" };
  }
}

function applyLastRevenue(calls, found) {
  return calls.map((call) => {
    const hit = found.get(call.symbol) || found.get(canonicalSymbol(call.symbol));
    if (!hit?.lastRevenue) return call;
    if (call.lastRevenue) return call;
    return {
      ...call,
      lastRevenue: hit.lastRevenue,
      lastRevenueDisplay: hit.lastRevenueDisplay,
    };
  });
}

const revenueCache = new Map();
const revenueInflight = new Map();
const REV_STORE = "earningsCalendar.lastRev.v1";
const REV_TTL_MS = 6 * 60 * 60 * 1000;

function readRevStore() {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(REV_STORE) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function rememberRevenue(ticker, data) {
  if (!data?.lastRevenue) return;
  revenueCache.set(ticker, { at: Date.now(), data });
  if (typeof localStorage === "undefined") return;
  try {
    const store = readRevStore();
    store[ticker] = {
      lastRevenue: data.lastRevenue,
      lastRevenueDisplay: data.lastRevenueDisplay,
      at: Date.now(),
    };
    localStorage.setItem(REV_STORE, JSON.stringify(store));
  } catch {
    // Ignore quota errors.
  }
}

function cachedRevenue(ticker) {
  const mem = revenueCache.get(ticker);
  if (mem?.data?.lastRevenue && Date.now() - mem.at < REV_TTL_MS) return mem.data;
  const saved = readRevStore()[ticker];
  if (saved?.lastRevenue && Date.now() - (saved.at || 0) < REV_TTL_MS) {
    const data = {
      lastRevenue: saved.lastRevenue,
      lastRevenueDisplay: saved.lastRevenueDisplay || "",
    };
    revenueCache.set(ticker, { at: saved.at || Date.now(), data });
    return data;
  }
  return null;
}

export function hydrateLastRevenue(calls) {
  return applyLastRevenue(
    calls,
    new Map(
      (calls || [])
        .map((call) => [call.symbol, cachedRevenue(canonicalSymbol(call.symbol))])
        .filter(([, data]) => data?.lastRevenue)
    )
  );
}

async function lookupRevenue(symbol, { fetchImpl } = {}) {
  const ticker = canonicalSymbol(symbol);
  const cached = cachedRevenue(ticker);
  if (cached) return cached;
  if (revenueInflight.has(ticker)) return revenueInflight.get(ticker);

  const pending = (async () => {
    try {
      if (typeof window !== "undefined") {
        const res = await fetch(`/api/revenue/${encodeURIComponent(ticker)}`, { cache: "no-store" });
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = await res.json();
          if (res.ok) {
            const data = {
              lastRevenue: Number(payload.lastRevenue) || 0,
              lastRevenueDisplay: payload.lastRevenueDisplay || "",
            };
            rememberRevenue(ticker, data);
            return data;
          }
        }
      }
    } catch {
      // Fall through to Nasdaq.
    }
    const data = await fetchLastQuarterRevenue(ticker, { fetchImpl });
    rememberRevenue(ticker, data);
    return data;
  })();

  revenueInflight.set(ticker, pending);
  try {
    return await pending;
  } finally {
    revenueInflight.delete(ticker);
  }
}

export async function enrichLastRevenue(
  calls,
  { fetchImpl = fetch, onProgress } = {}
) {
  const symbols = [];
  const seen = new Set();
  for (const call of calls) {
    if (seen.has(call.symbol) || call.lastRevenue) continue;
    seen.add(call.symbol);
    symbols.push(call.symbol);
  }
  if (!symbols.length) return calls;

  const found = new Map();
  let done = 0;
  await mapPool(symbols, 2, async (symbol) => {
    const data = await lookupRevenue(symbol, { fetchImpl });
    if (data?.lastRevenue) found.set(symbol, data);
    done += 1;
    if (onProgress && done % 8 === 0) onProgress(applyLastRevenue(calls, found));
  });
  return applyLastRevenue(calls, found);
}

async function lookupQuote(symbol, { fetchImpl, withEps } = {}) {
  try {
    if (typeof window !== "undefined") {
      const qs = withEps ? "?eps=1" : "";
      const res = await fetch(`/api/quote/${encodeURIComponent(symbol)}${qs}`, { cache: "no-store" });
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await res.json();
        if (res.ok && payload?.symbol) return payload;
      }
    }
  } catch {
    // Fall through to a direct Nasdaq lookup.
  }
  return fetchNasdaqQuoteLite(symbol, { fetchImpl, withEps }).catch(() => null);
}

function applyPrices(calls, prices) {
  return calls.map((call) => {
    const quote = prices.get(call.symbol);
    if (!quote || !nonemptyField(quote.price) || nonemptyField(call.price)) return call;
    return { ...call, price: quote.price };
  });
}

async function lookupPrice(symbol, { fetchImpl } = {}) {
  const ticker = String(symbol || "").trim().toUpperCase().replace(/-/g, ".");
  const cached = quoteCache.get(ticker);
  if (cached?.data?.price) return cached.data;
  try {
    if (typeof window !== "undefined") {
      const res = await fetch(`/api/price/${encodeURIComponent(ticker)}`, { cache: "no-store" });
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const payload = await res.json();
        if (res.ok && payload?.price) return payload;
      }
    }
  } catch {
    // Fall through to a direct Nasdaq lookup.
  }
  return fetchNasdaqPrice(ticker, { fetchImpl });
}

export async function fetchNasdaqPrice(symbol, { fetchImpl = fetch } = {}) {
  const ticker = String(symbol || "").trim().toUpperCase().replace(/-/g, ".");
  if (!isSymbol(ticker)) return null;
  const cached = quoteCache.get(ticker);
  if (cached?.data?.price && Date.now() - cached.at < 10 * 60 * 1000) {
    return { symbol: ticker, price: cached.data.price };
  }
  let info = null;
  for (const assetclass of ["stocks", "etf"]) {
    try {
      info = await nasdaqJson(
        `/api/quote/${encodeURIComponent(ticker)}/info?assetclass=${assetclass}`,
        { fetchImpl }
      );
      break;
    } catch {
      info = null;
    }
  }
  const price = val(info?.primaryData?.lastSalePrice);
  if (!price) return null;
  return { symbol: ticker, price };
}

export async function enrichCallPrices(calls, { fetchImpl = fetch, onProgress } = {}) {
  const symbols = [];
  const seen = new Set();
  for (const call of calls) {
    if (seen.has(call.symbol) || nonemptyField(call.price)) continue;
    seen.add(call.symbol);
    symbols.push(call.symbol);
  }
  if (!symbols.length) return calls;

  const found = new Map();
  let done = 0;
  await mapPool(symbols, 6, async (symbol) => {
    const data = await lookupPrice(symbol, { fetchImpl });
    if (data?.price) found.set(symbol, data);
    done += 1;
    if (onProgress && done % 12 === 0) onProgress(applyPrices(calls, found));
  });
  return applyPrices(calls, found);
}

export async function enrichSparseCalls(
  calls,
  { fetchImpl = fetch, limit = 250, onProgress } = {}
) {
  const missing = [];
  const seen = new Set();
  const wantEps = new Set();
  for (const call of calls) {
    if (seen.has(call.symbol)) continue;
    if (call.marketCap && call.name) continue;
    seen.add(call.symbol);
    missing.push(call.symbol);
    if (!nonemptyField(call.epsForecast)) wantEps.add(call.symbol);
    if (missing.length >= limit) break;
  }

  if (!missing.length) {
    return calls.filter(keepCalendarRow);
  }

  const quotes = new Map();
  let done = 0;
  await mapPool(missing, 5, async (symbol) => {
    const quote = await lookupQuote(symbol, { fetchImpl, withEps: wantEps.has(symbol) });
    quotes.set(symbol, quote || { missing: true });
    done += 1;
    if (onProgress && done % 10 === 0) onProgress(applyQuotes(calls, quotes).filter(keepCalendarRow));
  });
  return applyQuotes(calls, quotes).filter(keepCalendarRow);
}

function nonemptyField(value) {
  return value !== null && value !== undefined && String(value).trim() !== "" && value !== "—";
}

async function mapPool(items, width, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(width, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function padCik(value) {
  return String(value).replace(/\D/g, "").padStart(10, "0");
}

function tickerVariants(symbol) {
  const s = String(symbol || "").toUpperCase();
  return [...new Set([s, s.replace(".", "-"), s.replace("-", ".")])];
}

async function loadTickerMap({ fetchImpl = fetch } = {}) {
  if (tickerMapCache.map && Date.now() - tickerMapCache.at < 24 * 60 * 60 * 1000) {
    return tickerMapCache.map;
  }
  const res = await fetchImpl("https://www.sec.gov/files/company_tickers.json", {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SEC ticker map HTTP ${res.status}`);
  const payload = await res.json();
  const map = new Map();
  for (const row of Object.values(payload || {})) {
    if (row?.ticker) map.set(String(row.ticker).toUpperCase(), row);
  }
  tickerMapCache.at = Date.now();
  tickerMapCache.map = map;
  return map;
}

function filingLinks(cik, accession, primary) {
  const cikNum = String(Number(padCik(cik)));
  const acc = String(accession || "").replace(/-/g, "");
  const file = primary || "";
  return {
    document: file ? `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/${file}` : "",
    index: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc}/`,
  };
}

export async function fetchEdgarFilings(symbol, { fetchImpl = fetch, limit = 12 } = {}) {
  const ticker = String(symbol || "").trim().toUpperCase().replace(/-/g, ".");
  if (!isSymbol(ticker)) throw new Error("Invalid symbol");
  const map = await loadTickerMap({ fetchImpl });
  let row = null;
  for (const key of tickerVariants(ticker)) {
    if (map.has(key)) {
      row = map.get(key);
      break;
    }
  }
  if (!row) throw new Error("No SEC filings mapped for this ticker");

  const cik = padCik(row.cik_str);
  const res = await fetchImpl(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": SEC_UA, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`SEC submissions HTTP ${res.status}`);
  const payload = await res.json();
  const recent = payload?.filings?.recent || {};
  const forms = recent.form || [];
  const filings = [];
  for (let i = 0; i < forms.length && filings.length < limit; i++) {
    const form = forms[i];
    if (!EDGAR_FORMS.has(form)) continue;
    const accession = recent.accessionNumber?.[i] || "";
    const primary = recent.primaryDocument?.[i] || "";
    const links = filingLinks(cik, accession, primary);
    filings.push({
      form,
      filed: recent.filingDate?.[i] || "",
      reportDate: recent.reportDate?.[i] || "",
      description: recent.primaryDocDescription?.[i] || "",
      accession,
      documentUrl: links.document,
      indexUrl: links.index,
    });
  }
  return {
    cik,
    name: payload.name || row.title || "",
    sic: payload.sicDescription || "",
    filings,
  };
}

export async function fetchCompanyBundle(symbol, { fetchImpl = fetch } = {}) {
  const ticker = String(symbol || "").trim().toUpperCase().replace(/-/g, ".");
  const [quote, edgar] = await Promise.allSettled([
    fetchNasdaqCompany(ticker, { fetchImpl }),
    fetchEdgarFilings(ticker, { fetchImpl }),
  ]);
  const profile = quote.status === "fulfilled" ? quote.value : { symbol: ticker };
  const filings =
    edgar.status === "fulfilled"
      ? edgar.value
      : { cik: "", name: "", sic: "", filings: [] };
  return {
    ...profile,
    symbol: profile.symbol || ticker,
    name: formatCompanyName(profile.name || filings.name || ""),
    cik: filings.cik || "",
    sic: filings.sic || "",
    filings: filings.filings || [],
    nasdaqError: quote.status === "rejected" ? quote.reason?.message : "",
    edgarError: edgar.status === "rejected" ? edgar.reason?.message : "",
  };
}
