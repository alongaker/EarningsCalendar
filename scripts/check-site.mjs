#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeRow, parseMarketCap, formatMarketCap } from "./earnings-lib.mjs";
import { mergeCalls, normalizeFinnhub, mapTime, parseCsv, normalizeAlphaVantage, formatEps, formatCompanyName, marketDateIso, windowUpcoming } from "../providers.js";
import { isSymbol, normalizeCompany, roundToHundredth, enrichSparseCalls } from "../company.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

const row = normalizeRow(
  {
    symbol: "NVDA",
    name: "NVIDIA Corporation",
    time: "time-after-hours",
    marketCap: "$5,247,770,000,000",
    epsForecast: "$1.00",
    noOfEsts: "40",
    fiscalQuarterEnding: "Jul/2026",
    lastYearEPS: "$0.70",
    lastYearRptDt: "8/28/2025",
  },
  "2026-08-26"
);
assert(row.time === "after-close", "normalize after-hours timing");
assert(row.marketCap === 5247770000000, "parse large market cap");
assert(formatMarketCap(row.marketCap) === "$5.25T", "format trillions");
assert(parseMarketCap("N/A") === 0, "N/A market cap");
assert(mapTime("amc") === "after-close", "map amc timing");
assert(mapTime("08:00") === "before-open", "map morning clock");
assert(marketDateIso(new Date("2026-08-24T16:00:00Z")) === "2026-08-24", "afternoon ET is still Aug 24");
assert(marketDateIso(new Date("2026-08-25T03:30:00Z")) === "2026-08-24", "late evening ET stays prior date");
assert(marketDateIso(new Date("2026-08-25T04:30:00Z")) === "2026-08-25", "after midnight ET rolls forward");
const windowed = windowUpcoming(
  {
    startDate: "2026-08-21",
    endDate: "2026-08-26",
    calls: [
      { date: "2026-08-21", symbol: "OLD" },
      { date: "2026-08-24", symbol: "NOW" },
      { date: "2026-08-26", symbol: "LATER" },
    ],
  },
  "2026-08-24"
);
assert(windowed.startDate === "2026-08-24", "window start is today");
assert(windowed.count === 2 && windowed.calls[0].symbol === "NOW", "window drops past dates");

const merged = mergeCalls(
  [
    {
      date: "2026-08-26",
      symbol: "NVDA",
      name: "NVIDIA Corporation",
      time: "unspecified",
      marketCap: 100,
      marketCapDisplay: "$100",
      epsForecast: "",
      sources: ["nasdaq"],
    },
  ],
  [
    normalizeFinnhub({
      date: "2026-08-26",
      symbol: "nvda",
      hour: "amc",
      epsEstimate: 2.01,
      revenueEstimate: 46200000000,
      quarter: 2,
      year: 2026,
    }),
  ]
);
assert(merged.length === 1, "merge keeps one NVDA row");
assert(merged[0].time === "after-close", "merge fills missing time");
assert(merged[0].revenueEstimateDisplay === "$46.2B", "merge revenue");
assert(merged[0].sources.includes("finnhub"), "merge records finnhub");

const fuzzy = mergeCalls(
  [
    {
      date: "2026-08-26",
      symbol: "XYZ",
      name: "Xyz Inc",
      time: "after-close",
      marketCap: 500,
      marketCapDisplay: "$500",
      epsForecast: "$1.00",
      sources: ["nasdaq"],
    },
  ],
  [
    normalizeAlphaVantage({
      reportDate: "2026-08-28",
      symbol: "XYZ",
      name: "XYZ INC",
      estimate: "",
    }),
  ]
);
assert(fuzzy.length === 1, "fuzzy merge nearby Alpha Vantage date");
assert(fuzzy[0].date === "2026-08-26", "keep richer Nasdaq date");
assert(fuzzy[0].epsForecast === "$1.00", "keep Nasdaq EPS");
assert(fuzzy[0].sources.includes("alphavantage"), "record Alpha Vantage source");
assert(fuzzy[0].marketCapDisplay === "$500", "keep Nasdaq market cap display");
assert(formatEps("None") === "" && formatEps("n/a") === "", "blank Alpha Vantage estimates");

const hyphen = mergeCalls(
  [
    {
      date: "2026-08-26",
      symbol: "BRK.B",
      name: "Berkshire Hathaway",
      time: "after-close",
      marketCap: 900,
      marketCapDisplay: "$900B",
      epsForecast: "$4.00",
      sources: ["nasdaq"],
    },
  ],
  [
    normalizeAlphaVantage({
      reportDate: "2026-08-31",
      symbol: "BRK-B",
      name: "Berkshire Hathaway Inc",
      estimate: "None",
    }),
  ]
);
assert(hyphen.length === 1, "hyphen ticker matches dotted Nasdaq symbol");
assert(hyphen[0].symbol === "BRK.B", "keep Nasdaq share-class ticker");
assert(hyphen[0].date === "2026-08-26", "keep Nasdaq date across a 5-day gap");
assert(hyphen[0].epsForecast === "$4.00", "keep Nasdaq EPS over blank Alpha Vantage estimate");
assert(hyphen[0].marketCapDisplay === "$900B", "hyphen merge keeps cap display");

const far = mergeCalls(
  [
    {
      date: "2026-08-26",
      symbol: "AAA",
      name: "Aaa Inc",
      time: "after-close",
      marketCap: 10,
      marketCapDisplay: "$10",
      epsForecast: "$0.10",
      sources: ["nasdaq"],
    },
  ],
  [
    normalizeAlphaVantage({
      reportDate: "2026-09-10",
      symbol: "AAA",
      name: "AAA INC",
      estimate: "None",
    }),
  ]
);
assert(far.length === 1, "merge same ticker 15 days apart");
assert(far[0].date === "2026-08-26", "keep Nasdaq date when Alpha Vantage is far");
assert(far[0].epsForecast === "$0.10", "keep Nasdaq EPS when dates differ");
assert(formatCompanyName("APPLE INC") === "Apple Inc", "title-case all-caps names");
assert(formatCompanyName("BANK OF AMERICA CORP") === "Bank of America Corp", "small words stay short");
assert(formatCompanyName("NVIDIA Corporation") === "NVIDIA Corporation", "keep mixed-case names");
assert(formatCompanyName("XYZ INC") === "Xyz Inc", "caps inc suffix");
assert(formatCompanyName("Boxabl, Inc. Common Stock") === "Boxabl, Inc.", "drop common stock suffix");

const csv = parseCsv("symbol,name,reportDate,estimate\nAAPL,Apple Inc,2026-08-21,1.5");
assert(normalizeAlphaVantage(csv[0]).symbol === "AAPL", "alpha csv normalize");
assert(roundToHundredth("98,333,844.273655") === "98,333,844.27", "round volume");
assert(roundToHundredth("$215.0495") === "$215.05", "round price");
assert(roundToHundredth("+0.3295") === "+0.33", "round change");
assert(roundToHundredth("0.15%") === "0.15%", "keep two decimals");
assert(roundToHundredth("129,978,099") === "129,978,099", "keep integers");
assert(roundToHundredth(1.876) === 1.88, "round numeric eps");
const company = normalizeCompany({
  info: {
    symbol: "NVDA",
    companyName: "NVIDIA Corporation Common Stock",
    exchange: "NASDAQ-GS",
    primaryData: { lastSalePrice: "$215.0495", netChange: "+1.00", percentageChange: "+0.47%", deltaIndicator: "up", volume: "98,333,844.273655" },
  },
  profile: {
    CompanyName: { value: "NVIDIA Corporation" },
    Sector: { value: "Technology" },
    CompanyDescription: { value: "AI chips" },
  },
  surprises: {
    earningsSurpriseTable: { rows: [{ fiscalQtrEnd: "Apr 2026", dateReported: "5/20/2026", eps: 1.87, consensusForecast: "1.7", percentageSurprise: "10" }] },
  },
});
assert(company.name === "NVIDIA Corporation", "company name");
assert(company.price === "$215.05", "company price");
assert(company.volume === "98,333,844.27", "company volume rounded");
assert(company.earningsHistory.length === 1, "earnings history");

const filled = await enrichSparseCalls(
  [
    {
      date: "2026-08-26",
      symbol: "NVDA",
      name: "",
      marketCap: 0,
      marketCapDisplay: "—",
    },
  ],
  {
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("/info")) {
        return {
          ok: true,
          json: async () => ({
            status: { rCode: 200 },
            data: { symbol: "NVDA", companyName: "NVIDIA Corporation", assetClass: "stocks" },
          }),
        };
      }
      if (u.includes("/summary")) {
        return {
          ok: true,
          json: async () => ({
            status: { rCode: 200 },
            data: { summaryData: { MarketCap: { value: "4,000,000,000,000" } } },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
  }
);
assert(filled[0].marketCap === 4000000000000, "enrich fills market cap from quote");
assert(filled[0].name === "NVIDIA Corporation", "enrich fills company name");
assert(filled[0].marketCapDisplay === "$4.00T", "enrich formats market cap");

const html = await readFile(join(root, "index.html"), "utf8");
assert(html.includes("Earnings Calendar"), "index has title");
assert(html.includes("API keys"), "index has API keys tab");
assert(html.includes("view-company"), "index has company view");
assert(html.includes("./app.js"), "index loads app.js");
assert(html.includes("./styles.css"), "index loads styles");

const json = JSON.parse(await readFile(join(root, "data", "earnings.json"), "utf8"));
assert(Array.isArray(json.calls) && json.calls.length > 0, "snapshot has calls");
assert(json.calls.every((c) => c.symbol && c.date), "calls have symbol and date");

const server = spawn("node", ["server.js"], {
  cwd: root,
  env: { ...process.env, PORT: "3456", HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});

function shutdown() {
  server.kill("SIGTERM");
}

try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server start timeout")), 8000);
    server.stdout.on("data", (buf) => {
      if (String(buf).includes("Earnings Calendar running")) {
        clearTimeout(t);
        resolve();
      }
    });
    server.on("error", reject);
  });

  const health = await fetch("http://127.0.0.1:3456/api/health");
  assert(health.ok, "health endpoint");
  const home = await fetch("http://127.0.0.1:3456/");
  const body = await home.text();
  assert(home.ok && body.includes("Earnings Calendar"), "serves homepage");
  const snap = await fetch("http://127.0.0.1:3456/api/earnings?live=0");
  const snapJson = await snap.json();
  assert(snap.ok && snapJson.count > 0, "snapshot API");
  assert(
    snapJson.calls.every((c) => c.date >= marketDateIso()),
    "snapshot API hides dates before today"
  );
  const missing = await fetch("http://127.0.0.1:3456/api/provider/finnhub", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const missingJson = await missing.json();
  assert(missing.status === 400 && missingJson.error, "provider requires API key");
  const unknown = await fetch("http://127.0.0.1:3456/api/provider/nope", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "x", from: "2026-08-21", to: "2026-09-10" }),
  });
  assert(unknown.status === 404, "unknown provider");
  const badCompany = await fetch("http://127.0.0.1:3456/api/company/-BAD");
  assert(badCompany.status === 400, "invalid company symbol");
  const nvda = await fetch("http://127.0.0.1:3456/api/company/NVDA");
  const nvdaJson = await nvda.json();
  assert(nvda.ok && nvdaJson.symbol === "NVDA" && nvdaJson.price, "company profile API");
  assert(Array.isArray(nvdaJson.filings) && nvdaJson.filings.length > 0, "SEC filings on company page");
  assert(nvdaJson.cik, "SEC CIK");
  const quote = await fetch("http://127.0.0.1:3456/api/quote/NVDA");
  const quoteJson = await quote.json();
  assert(quote.ok && quoteJson.marketCap > 0, "quote lite API");
} finally {
  shutdown();
}

if (failures.length) {
  console.error("check failed:");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("check ok");
