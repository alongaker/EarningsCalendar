import { formatCompanyName } from "../providers.js";

const NASDAQ_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const TIME_MAP = {
  "time-pre-market": "before-open",
  "time-after-hours": "after-close",
  "time-not-supplied": "unspecified",
};

export function parseMarketCap(value) {
  if (!value || value === "N/A") return 0;
  const n = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function formatMarketCap(n) {
  if (!n) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(d, n) {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
}

export function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function normalizeRow(row, date) {
  const marketCap = parseMarketCap(row.marketCap);
  const time = TIME_MAP[row.time] || "unspecified";
  return {
    date,
    symbol: (row.symbol || "").trim().toUpperCase().replace(/-/g, "."),
    name: formatCompanyName(row.name),
    time,
    marketCap,
    marketCapDisplay: formatMarketCap(marketCap),
    epsForecast: (row.epsForecast || "").trim(),
    estimateCount: Number(row.noOfEsts) || 0,
    fiscalQuarterEnding: (row.fiscalQuarterEnding || "").trim(),
    lastYearEPS: (row.lastYearEPS || "").trim(),
    lastYearReportDate: (row.lastYearRptDt || "").trim(),
  };
}

export async function fetchDay(date, { fetchImpl = fetch } = {}) {
  const url = `https://api.nasdaq.com/api/calendar/earnings?date=${date}`;
  const res = await fetchImpl(url, {
    headers: {
      "User-Agent": NASDAQ_UA,
      Accept: "application/json,text/plain,*/*",
      Origin: "https://www.nasdaq.com",
      Referer: "https://www.nasdaq.com/",
    },
  });
  if (!res.ok) {
    throw new Error(`Nasdaq ${date} → HTTP ${res.status}`);
  }
  const payload = await res.json();
  const rows = payload?.data?.rows || [];
  return rows
    .map((row) => normalizeRow(row, date))
    .filter((row) => row.symbol);
}

export async function fetchUpcoming({
  days = 21,
  start = startOfUtcDay(),
  pauseMs = 80,
  fetchImpl = fetch,
} = {}) {
  const startDate = isoDate(start);
  const calls = [];
  const errors = [];

  for (let i = 0; i < days; i++) {
    const date = isoDate(addDays(start, i));
    try {
      const rows = await fetchDay(date, { fetchImpl });
      calls.push(...rows);
    } catch (err) {
      errors.push({ date, message: err.message });
    }
    if (pauseMs && i < days - 1) {
      await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }

  calls.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (b.marketCap !== a.marketCap) return b.marketCap - a.marketCap;
    return a.symbol.localeCompare(b.symbol);
  });

  const endDate = isoDate(addDays(start, days - 1));
  return {
    source: "nasdaq",
    sourceLabel: "Nasdaq Earnings Calendar",
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    count: calls.length,
    errors,
    calls,
  };
}
