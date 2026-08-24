const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const PROVIDERS = [
  {
    id: "finnhub",
    name: "Finnhub",
    blurb: "Adds more tickers plus EPS and revenue estimates.",
    signup: "https://finnhub.io/register",
    docs: "https://finnhub.io/docs/api/earnings-calendar",
    placeholder: "Finnhub API key",
  },
  {
    id: "fmp",
    name: "Financial Modeling Prep",
    blurb: "Adds revenue figures, extra names, and confirmed report times.",
    signup: "https://site.financialmodelingprep.com/register",
    docs: "https://site.financialmodelingprep.com/developer/docs#earnings-calendar",
    placeholder: "FMP API key",
  },
  {
    id: "alphavantage",
    name: "Alpha Vantage",
    blurb: "Adds more names. Empty estimates stay blank; we match nearby Nasdaq dates and fill market cap when the ticker is listed.",
    signup: "https://www.alphavantage.co/support/#api-key",
    docs: "https://www.alphavantage.co/documentation/#earnings-calendar",
    placeholder: "Alpha Vantage API key",
  },
];

export function providerIds() {
  return PROVIDERS.map((p) => p.id);
}

export function canonicalSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase().replace(/-/g, ".");
}

export const MARKET_TZ = "America/New_York";

export function marketDateIso(d = new Date(), timeZone = MARKET_TZ) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function startOfMarketDay(d = new Date(), timeZone = MARKET_TZ) {
  return new Date(`${marketDateIso(d, timeZone)}T00:00:00.000Z`);
}

const NON_OPERATING_NAME =
  /\b(?:etfs?|etns?|exchange[\s-]*traded|closed[\s-]*end|mutual\s+funds?|blank\s+check|spacs?)\b|\bacquisition\s+(?:corp(?:oration)?|co\.?|company)\b|\b(?:royalt\w*|oil)\s+(?:\w+\s+)?trusts?\b|\bfunds?\b/i;

export function isOperatingCompany(name) {
  const n = String(name || "").trim();
  if (!n) return true;
  return !NON_OPERATING_NAME.test(n);
}

export function isPlaceholderName(name, symbol) {
  const n = String(name || "").trim();
  if (!n || n === "—" || n === "-") return true;
  if (/^(n\/a|na|none|null|unknown|undefined)$/i.test(n)) return true;
  if (/symbol\s+not\s+(found|exist|exists)\b/i.test(n)) return true;
  if (/^not\s+(found|available|exist|exists)\b/i.test(n)) return true;
  const ticker = String(symbol || "").trim();
  if (ticker && n.toUpperCase() === ticker.toUpperCase()) return true;
  return false;
}

export function keepCalendarRow(call) {
  if (!call?.symbol || !call?.date) return false;
  if (call.unlisted) return false;
  if (!isOperatingCompany(call.name)) return false;
  if (isPlaceholderName(call.name, call.symbol)) return false;
  return true;
}

export function windowUpcoming(snap, today = marketDateIso()) {
  const calls = (snap?.calls || []).filter(
    (call) => call.date >= today && keepCalendarRow(call)
  );
  return {
    ...snap,
    startDate: calls[0]?.date || today,
    endDate: calls.at(-1)?.date || snap?.endDate || today,
    count: calls.length,
    calls,
  };
}

export function parseMarketCap(value) {
  if (!value || value === "N/A" || value === "—") return 0;
  const n = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function formatMarketCap(n) {
  if (!n) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(0)}M`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

const NAME_SPECIAL = {
  inc: "Inc",
  corp: "Corp",
  ltd: "Ltd",
  llc: "LLC",
  llp: "LLP",
  lp: "LP",
  plc: "PLC",
  nv: "NV",
  sa: "SA",
  ag: "AG",
  se: "SE",
  co: "Co",
  usa: "USA",
  us: "US",
  uk: "UK",
  adr: "ADR",
  ads: "ADS",
  etf: "ETF",
  etn: "ETN",
  reit: "REIT",
  ai: "AI",
  spa: "SPA",
  bancorp: "Bancorp",
};

const NAME_SMALL = new Set(["and", "or", "of", "the", "for", "in", "on", "at", "to", "a", "an", "de", "da", "di"]);

export function formatCompanyName(name) {
  let s = String(name || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  s = s.replace(/\s+(common stock|ordinary shares|american depositary shares)$/i, "");
  const letters = s.match(/[A-Za-z]/g) || [];
  if (letters.length < 2) return s;
  const lowerCount = (s.match(/[a-z]/g) || []).length;
  const upperCount = (s.match(/[A-Z]/g) || []).length;
  if (lowerCount > 0 && upperCount / letters.length < 0.8) return s;

  let index = 0;
  return s.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (word) => {
    const i = index++;
    const lower = word.toLowerCase();
    if (NAME_SPECIAL[lower]) return NAME_SPECIAL[lower];
    if (i > 0 && NAME_SMALL.has(lower)) return lower;
    if (/^o'[a-z]/i.test(word)) {
      return `O'${word.slice(2, 3).toUpperCase()}${word.slice(3).toLowerCase()}`;
    }
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  });
}

export function formatEps(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") {
    const s = value.trim();
    if (!s || /^(n\/a|na|none|null|-|—)$/i.test(s)) return "";
    if (s.startsWith("$") || s.startsWith("($")) return s;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value).trim();
  const formatted = Math.abs(n).toFixed(2);
  return n < 0 ? `($${formatted})` : `$${formatted}`;
}

export function formatRevenue(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "";
  const formatted = formatMarketCap(n);
  return formatted === "—" ? "" : formatted;
}

export function mapTime(value) {
  if (!value && value !== 0) return "unspecified";
  const s = String(value).trim().toLowerCase();
  if (!s || s === "n/a" || s === "time-not-supplied") return "unspecified";
  if (s.includes("bmo") || s.includes("pre-market") || s.includes("before")) return "before-open";
  if (s.includes("amc") || s.includes("after") || s.includes("post")) return "after-close";
  if (s.includes("dmh") || s.includes("during")) return "during-session";
  const clock = s.match(/^(\d{1,2}):(\d{2})/);
  if (clock) {
    const hour = Number(clock[1]);
    if (hour < 10) return "before-open";
    if (hour >= 16) return "after-close";
    return "during-session";
  }
  return "unspecified";
}

function baseCall(partial) {
  const revenueEstimate = Number(partial.revenueEstimate) || 0;
  return {
    date: partial.date || "",
    symbol: canonicalSymbol(partial.symbol),
    name: formatCompanyName(partial.name),
    time: partial.time || "unspecified",
    marketCap: Number(partial.marketCap) || 0,
    marketCapDisplay: partial.marketCapDisplay || (partial.marketCap ? "" : "—"),
    epsForecast: partial.epsForecast || "",
    estimateCount: Number(partial.estimateCount) || 0,
    fiscalQuarterEnding: partial.fiscalQuarterEnding || "",
    lastYearEPS: partial.lastYearEPS || "",
    lastYearReportDate: partial.lastYearReportDate || "",
    revenueEstimate,
    revenueEstimateDisplay: partial.revenueEstimateDisplay || formatRevenue(revenueEstimate),
    epsActual: partial.epsActual || "",
    sources: partial.sources || [],
  };
}

export function normalizeFinnhub(row) {
  return baseCall({
    date: row.date,
    symbol: row.symbol,
    time: mapTime(row.hour),
    epsForecast: formatEps(row.epsEstimate),
    epsActual: formatEps(row.epsActual),
    revenueEstimate: row.revenueEstimate,
    fiscalQuarterEnding: row.quarter && row.year ? `Q${row.quarter} ${row.year}` : "",
    sources: ["finnhub"],
  });
}

export function normalizeFmp(row) {
  return baseCall({
    date: row.date,
    symbol: row.symbol,
    name: row.name || row.companyName || "",
    time: mapTime(row.time),
    epsForecast: formatEps(row.epsEstimated ?? row.epsEstimate),
    epsActual: formatEps(row.eps),
    revenueEstimate: row.revenueEstimated ?? row.revenueEstimate,
    fiscalQuarterEnding: row.fiscalDateEnding || "",
    sources: ["fmp"],
  });
}

export function parseCsv(text) {
  const lines = String(text)
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        cols.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] || "").trim();
    });
    return row;
  });
}

export function normalizeAlphaVantage(row) {
  return baseCall({
    date: row.reportDate,
    symbol: row.symbol,
    name: row.name,
    epsForecast: formatEps(row.estimate),
    fiscalQuarterEnding: row.fiscalDateEnding || "",
    sources: ["alphavantage"],
  });
}

function nonempty(value) {
  return value !== null && value !== undefined && String(value).trim() !== "" && value !== "—";
}

function dayNum(iso) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? t / 86400000 : NaN;
}

function richness(call) {
  return (
    (call.marketCap ? 4 : 0) +
    (nonempty(call.epsForecast) ? 3 : 0) +
    (call.time && call.time !== "unspecified" ? 2 : 0) +
    (nonempty(call.revenueEstimateDisplay) ? 1 : 0) +
    (nonempty(call.name) ? 1 : 0)
  );
}

function mergePair(prev, call) {
  const time =
    prev.time === "unspecified" && call.time !== "unspecified" ? call.time : prev.time;
  const keepDate = richness(call) > richness(prev) ? call.date : prev.date;
  return {
    ...prev,
    date: keepDate,
    symbol: prev.symbol || call.symbol,
    name: nonempty(prev.name) ? formatCompanyName(prev.name) : formatCompanyName(call.name),
    time,
    marketCap: prev.marketCap || call.marketCap,
    marketCapDisplay:
      (prev.marketCap || nonempty(prev.marketCapDisplay))
        ? prev.marketCapDisplay
        : call.marketCapDisplay || "—",
    epsForecast: nonempty(prev.epsForecast) ? prev.epsForecast : call.epsForecast,
    estimateCount: prev.estimateCount || call.estimateCount,
    fiscalQuarterEnding: nonempty(prev.fiscalQuarterEnding)
      ? prev.fiscalQuarterEnding
      : call.fiscalQuarterEnding,
    lastYearEPS: nonempty(prev.lastYearEPS) ? prev.lastYearEPS : call.lastYearEPS,
    lastYearReportDate: nonempty(prev.lastYearReportDate)
      ? prev.lastYearReportDate
      : call.lastYearReportDate,
    revenueEstimate: prev.revenueEstimate || call.revenueEstimate,
    revenueEstimateDisplay: nonempty(prev.revenueEstimateDisplay)
      ? prev.revenueEstimateDisplay
      : call.revenueEstimateDisplay,
    epsActual: nonempty(prev.epsActual) ? prev.epsActual : call.epsActual,
    sources: [...new Set([...(prev.sources || []), ...(call.sources || [])])],
  };
}

export function mergeCalls(base, extras, { dateWindow = 45 } = {}) {
  const bySymbol = new Map();

  const put = (call) => {
    if (!call.symbol || !call.date) return;
    const incoming = {
      ...call,
      symbol: canonicalSymbol(call.symbol),
      name: formatCompanyName(call.name),
      sources: [...new Set(call.sources || [])],
    };
    if (!incoming.symbol || !isOperatingCompany(incoming.name)) return;
    const list = bySymbol.get(incoming.symbol) || [];
    const d = dayNum(incoming.date);
    const idx = list.findIndex((prev) => Math.abs(dayNum(prev.date) - d) <= dateWindow);
    if (idx === -1) list.push(incoming);
    else list[idx] = mergePair(list[idx], incoming);
    bySymbol.set(incoming.symbol, list);
  };

  for (const call of base) put({ ...call, sources: call.sources || ["nasdaq"] });
  for (const call of extras) put(call);

  return [...bySymbol.values()].flat().sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (b.marketCap !== a.marketCap) return b.marketCap - a.marketCap;
    return a.symbol.localeCompare(b.symbol);
  });
}

function providerError(payload, status) {
  if (!payload) return `HTTP ${status}`;
  if (typeof payload === "string") {
    const cut = payload.slice(0, 180);
    if (/invalid|error|note|premium/i.test(cut)) return cut;
    return `HTTP ${status}`;
  }
  return (
    payload.error ||
    payload.Error ||
    payload["Error Message"] ||
    payload.Note ||
    payload.Information ||
    `HTTP ${status}`
  );
}

async function fetchJson(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": UA, Accept: "application/json,text/csv,text/plain,*/*" },
  });
  const text = await res.text();
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!res.ok) {
    throw new Error(providerError(payload, res.status));
  }
  return payload;
}

export async function fetchProvider(id, apiKey, { from, to, fetchImpl = fetch } = {}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("API key required");

  if (id === "finnhub") {
    const url = new URL("https://finnhub.io/api/v1/calendar/earnings");
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("token", key);
    const payload = await fetchJson(url, { fetchImpl });
    const rows = payload?.earningsCalendar || [];
    return rows.map(normalizeFinnhub).filter((c) => c.symbol && c.date && isOperatingCompany(c.name));
  }

  if (id === "fmp") {
    const url = new URL("https://financialmodelingprep.com/stable/earnings-calendar");
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("apikey", key);
    let payload;
    try {
      payload = await fetchJson(url, { fetchImpl });
    } catch {
      const fallback = new URL("https://financialmodelingprep.com/api/v3/earning_calendar");
      fallback.searchParams.set("from", from);
      fallback.searchParams.set("to", to);
      fallback.searchParams.set("apikey", key);
      payload = await fetchJson(fallback, { fetchImpl });
    }
    const rows = Array.isArray(payload) ? payload : [];
    return rows.map(normalizeFmp).filter((c) => c.symbol && c.date && isOperatingCompany(c.name));
  }

  if (id === "alphavantage") {
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "EARNINGS_CALENDAR");
    url.searchParams.set("horizon", "3month");
    url.searchParams.set("apikey", key);
    const res = await fetchImpl(url, {
      headers: { "User-Agent": UA, Accept: "text/csv,application/json,text/plain,*/*" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(providerError(text, res.status));
    if (/[{[]/.test(text.trim()[0] || "")) {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("Alpha Vantage returned an unexpected response");
      }
      throw new Error(providerError(payload, res.status));
    }
    const rows = parseCsv(text);
    return rows
      .map(normalizeAlphaVantage)
      .filter((c) => c.symbol && c.date && c.date >= from && c.date <= to && isOperatingCompany(c.name));
  }

  throw new Error(`Unknown provider: ${id}`);
}
