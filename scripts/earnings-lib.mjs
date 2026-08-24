import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatCompanyName, startOfMarketDay, parseMarketCap, formatMarketCap, isOperatingCompany } from "../providers.js";
import { enrichLastRevenue } from "../company.js";

export { parseMarketCap, formatMarketCap };

const NASDAQ_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const TIME_MAP = {
  "time-pre-market": "before-open",
  "time-after-hours": "after-close",
  "time-not-supplied": "unspecified",
};

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(d, n) {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + n);
  return next;
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
    .filter((row) => row.symbol && isOperatingCompany(row.name));
}

export async function fetchUpcoming({
  days = 21,
  start = startOfMarketDay(),
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

const isCli =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const outFile = join(root, "data", "earnings.json");
  const days = Number(process.env.EARNINGS_DAYS || 21);
  const snapshot = await fetchUpcoming({ days });
  snapshot.calls = await enrichLastRevenue(snapshot.calls);
  snapshot.count = snapshot.calls.length;
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(snapshot)}\n`);
  const errNote = snapshot.errors.length
    ? ` (${snapshot.errors.length} day(s) failed)`
    : "";
  console.log(
    `Wrote ${snapshot.count} calls ${snapshot.startDate} → ${snapshot.endDate}${errNote} to data/earnings.json`
  );
}
