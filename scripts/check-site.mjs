#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeRow, parseMarketCap, formatMarketCap } from "./earnings-lib.mjs";
import { mergeCalls, normalizeFinnhub, mapTime, parseCsv, normalizeAlphaVantage } from "../providers.js";
import { isSymbol, normalizeCompany } from "../company.js";

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

const csv = parseCsv("symbol,name,reportDate,estimate\nAAPL,Apple Inc,2026-08-21,1.5");
assert(normalizeAlphaVantage(csv[0]).symbol === "AAPL", "alpha csv normalize");
assert(isSymbol("NVDA") && !isSymbol("../etc") && !isSymbol(""), "symbol guard");
const company = normalizeCompany({
  info: {
    symbol: "NVDA",
    companyName: "NVIDIA Corporation Common Stock",
    exchange: "NASDAQ-GS",
    primaryData: { lastSalePrice: "$215.00", netChange: "+1.00", percentageChange: "+0.47%", deltaIndicator: "up" },
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
assert(company.price === "$215.00", "company price");
assert(company.earningsHistory.length === 1, "earnings history");

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
} finally {
  shutdown();
}

if (failures.length) {
  console.error("check failed:");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("check ok");
