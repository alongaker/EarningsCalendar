#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeRow, parseMarketCap, formatMarketCap } from "./earnings-lib.mjs";
import { mergeCalls, normalizeFinnhub, mapTime, parseCsv, normalizeAlphaVantage, normalizeApiNinjas, normalizeEodhd, normalizeTwelveData, formatEps, formatFiscalPeriod, formatCompanyName, stripCompanySuffixes, marketDateIso, windowUpcoming, isOperatingCompany, isPlaceholderName, keepCalendarRow, providersByName, rankedIds, reorderIds, OPTIONS_PROVIDERS, testOratsKey, formatMdY, daysUntilIso } from "../providers.js";
import { isSymbol, normalizeCompany, roundToHundredth, enrichSparseCalls, lastQuarterRevenueFromTable, parseRevenueCell } from "../company.js";

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
assert(formatFiscalPeriod("Jun/2026") === "Q2 2026", "Nasdaq June EoP is Q2");
assert(formatFiscalPeriod("Jul/2026") === "Q3 2026", "Nasdaq July EoP is Q3");
assert(formatFiscalPeriod("May/2026") === "Q2 2026", "Nasdaq May EoP is Q2");
assert(formatFiscalPeriod("Q2 2026") === "Q2 2026", "keep explicit quarter");
assert(formatFiscalPeriod("Q3 FY2026") === "Q3 2026", "normalize FY quarter");
assert(formatFiscalPeriod("2026-03-31") === "Q1 2026", "ISO period ending");
assert(formatFiscalPeriod("") === "" && formatFiscalPeriod("N/A") === "", "blank fiscal period stays empty");
assert(mapTime("amc") === "after-close", "map amc timing");
assert(mapTime("08:00") === "before-open", "map morning clock");
assert(marketDateIso(new Date("2026-08-24T16:00:00Z")) === "2026-08-24", "afternoon ET is still Aug 24");
assert(marketDateIso(new Date("2026-08-25T03:30:00Z")) === "2026-08-24", "late evening ET stays prior date");
assert(marketDateIso(new Date("2026-08-25T04:30:00Z")) === "2026-08-25", "after midnight ET rolls forward");
assert(formatMdY("2026-08-25") === "08/25/26", "announce date MM/DD/YY");
assert(daysUntilIso("2026-08-25", "2026-08-25") === 0, "same-day announce is 0 days until");
assert(daysUntilIso("2026-08-27", "2026-08-25") === 2, "days until later announce date");
const windowed = windowUpcoming(
  {
    startDate: "2026-08-21",
    endDate: "2026-08-26",
    calls: [
      { date: "2026-08-21", symbol: "OLD", name: "Old Co", marketCap: 1e9 },
      { date: "2026-08-24", symbol: "NOW", name: "Now Co", marketCap: 1e9 },
      { date: "2026-08-26", symbol: "LATER", name: "Later Co", marketCap: 1e9 },
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
assert(stripCompanySuffixes("ChronoScale Holdings Corporation") === "ChronoScale Holdings", "drop Corporation");
assert(stripCompanySuffixes("NAPCO Security Technologies, Inc.") === "NAPCO Security Technologies", "drop Inc keep Technologies");
assert(stripCompanySuffixes("CBAK Energy Technology Limited") === "CBAK Energy Technology", "drop Limited");
assert(stripCompanySuffixes("Apartment Investment and Management Company") === "Apartment Investment and Management Company", "keep Company");
assert(stripCompanySuffixes("The Marzetti Co") === "The Marzetti Company", "write Co as Company");
assert(stripCompanySuffixes("The Marzetti Company") === "The Marzetti Company", "Company stays Company");
assert(stripCompanySuffixes("Foo Incorporated") === "Foo", "drop Incorporated");
assert(stripCompanySuffixes("Bank of America Corp") === "Bank of America", "drop Corp");
assert(stripCompanySuffixes("Heico Corporation, Inc.") === "Heico", "drop stacked legal suffixes");
assert(stripCompanySuffixes("Unlimited Power Ltd") === "Unlimited Power", "drop Ltd keep Unlimited");
assert(stripCompanySuffixes("Grifols, S.A.") === "Grifols", "drop S.A.");
assert(stripCompanySuffixes("Costco") === "Costco", "Costco is not Co");
assert(isOperatingCompany("NVIDIA Corporation"), "keep operating companies");
assert(!isOperatingCompany("SPDR S&P 500 ETF Trust"), "drop ETFs");
assert(!isOperatingCompany("PIMCO Corporate Opportunity Fund"), "drop funds");
assert(!isOperatingCompany("American Exceptionalism Acquisition Corp. A"), "drop SPACs");
assert(!isOperatingCompany("North European Oil Royality Trust"), "drop royalty trusts");
assert(!isOperatingCompany("InnSuites Hospitality Trust"), "drop trusts");
assert(!isOperatingCompany("FS Credit Opportunities Corp."), "drop credit opportunity vehicles");
assert(!isOperatingCompany("Pearl Diver Credit Company Inc."), "drop credit companies");
assert(isOperatingCompany("Apartment Investment and Management Company"), "keep apartment operators");
assert(isOperatingCompany("Credit Acceptance Corporation"), "keep operating lenders");
assert(isPlaceholderName("", "ZZZ"), "empty name is a placeholder");
assert(isPlaceholderName("Symbol not exists", "ZZZ"), "nasdaq missing-symbol message");
assert(isPlaceholderName("ZZZ", "ZZZ"), "ticker used as name is a placeholder");
assert(!keepCalendarRow({ date: "2026-08-26", symbol: "ZZZ", name: "" }), "drop nameless rows");
assert(
  keepCalendarRow({ date: "2026-08-26", symbol: "NVDA", name: "NVIDIA Corporation", marketCap: 4e12 }),
  "keep named large-cap rows"
);
assert(
  !keepCalendarRow({ date: "2026-08-26", symbol: "TINY", name: "Tiny Co", marketCap: 10_000_000 }),
  "drop names under $50M"
);
assert(
  !keepCalendarRow({ date: "2026-08-26", symbol: "NVDA", name: "NVIDIA Corporation", marketCap: 0 }),
  "drop unknown market cap"
);

const ninja = normalizeApiNinjas({
  date: "2026-08-26",
  ticker: "MSFT",
  name: "Microsoft Corp",
  estimated_eps: 2.5,
});
assert(ninja.symbol === "MSFT" && ninja.sources.includes("apininjas"), "normalize API Ninjas");
const eod = normalizeEodhd({
  report_date: "2026-08-26",
  code: "AAPL.US",
  before_after_market: "AfterMarket",
  estimate: 1.1,
});
assert(eod.symbol === "AAPL" && eod.time === "after-close", "normalize EODHD listed symbol");
const twelve = normalizeTwelveData({
  date: "2026-08-26",
  symbol: "IBM",
  name: "IBM",
  time: "bmo",
  eps_estimate: 1.2,
});
assert(twelve.time === "before-open" && twelve.sources.includes("twelvedata"), "normalize Twelve Data");
const names = providersByName().map((p) => p.name);
assert(names.slice().sort((a, b) => a.localeCompare(b, "en")).join() === names.join(), "providers listed A–Z by name");
assert(rankedIds(["c", "a", "b"], ["b", "a"]).join() === "b,a,c", "saved rank then remaining sources");
assert(rankedIds(["finnhub", "fmp"], []).join() === "finnhub,fmp", "empty rank keeps given order");
assert(reorderIds(["a", "b", "c"], "a", 2).join() === "b,c,a", "move first source to end");
assert(reorderIds(["a", "b", "c"], "c", 0).join() === "c,a,b", "move last source to front");

const nasdaqSparse = {
  date: "2026-08-26",
  symbol: "NVDA",
  name: "NVIDIA Corporation",
  time: "unspecified",
  marketCap: 100,
  marketCapDisplay: "$100",
  epsForecast: "",
  revenueEstimate: 0,
  revenueEstimateDisplay: "",
  sources: ["nasdaq"],
};
const extraFmp = {
  date: "2026-08-26",
  symbol: "NVDA",
  name: "NVIDIA Corporation",
  time: "after-close",
  marketCap: 0,
  epsForecast: "$1.00",
  revenueEstimate: 10,
  revenueEstimateDisplay: "$10B",
  sources: ["fmp"],
};
const extraFinnhub = {
  ...extraFmp,
  revenueEstimate: 99,
  revenueEstimateDisplay: "$99B",
  sources: ["finnhub"],
};
const preferFmp = mergeCalls([nasdaqSparse], [extraFmp, extraFinnhub]);
assert(preferFmp[0].revenueEstimateDisplay === "$10B", "higher-ranked extra keeps revenue");
const preferFinnhub = mergeCalls([nasdaqSparse], [extraFinnhub, extraFmp]);
assert(preferFinnhub[0].revenueEstimateDisplay === "$99B", "lower-ranked extra does not overwrite revenue");

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
assert(parseRevenueCell("$109,417(m)") === 109417000000, "Nasdaq millions revenue cell");
assert(parseRevenueCell("$8,558(m)") === 8558000000, "parse mid-size quarterly revenue");
assert(
  lastQuarterRevenueFromTable({
    rows: [
      { value1: "March", value2: "", value3: "" },
      { value1: "Revenue", value2: "$3,885(m)", value3: "$3,283(m)" },
      { value1: "June", value2: "", value3: "" },
      { value1: "Revenue", value2: "$4,651(m)", value3: "$3,963(m)" },
      { value1: "September", value2: "", value3: "" },
      { value1: "Revenue", value2: "", value3: "$7,754(m)" },
      { value1: "Totals", value2: "", value3: "" },
      { value1: "Revenue", value2: "$8,536(m)", value3: "$18,831(m)" },
    ],
  }) === 4651000000,
  "last quarter skips empty current period and totals"
);

const gone = await enrichSparseCalls(
  [
    {
      date: "2026-08-26",
      symbol: "ZZZZ",
      name: "",
      marketCap: 0,
      marketCapDisplay: "—",
    },
  ],
  {
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
  }
);
assert(gone.length === 0, "drop tickers Nasdaq does not recognize");

const html = await readFile(join(root, "index.html"), "utf8");
assert(html.includes("Earnings Calendar"), "index has title");
assert(html.includes("API Key Management"), "index has API keys page");
assert(html.includes("options-keys-title"), "index has options-specific API key section");
assert(html.includes("options-key-list"), "index has options key list");
assert(html.includes("Options-specific API key"), "options key heading");
assert(OPTIONS_PROVIDERS.some((p) => p.id === "orats"), "ORATS is the options provider");
{
  let called = "";
  const result = await testOratsKey("token-xyz", {
    fetchImpl: async (url) => {
      called = String(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [{ ticker: "AAPL", min: "2007-01-03", max: "2026-08-25" }] }),
      };
    },
  });
  assert(called.includes("api.orats.io/datav2/tickers"), "ORATS test hits tickers endpoint");
  assert(called.includes("ticker=AAPL"), "ORATS test uses a sample ticker");
  assert(result.ok && result.ticker === "AAPL", "ORATS test accepts a valid payload");
}
try {
  await testOratsKey("bad", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [], message: "Invalid token" }),
    }),
  });
  assert(false, "ORATS test should reject an invalid token");
} catch (err) {
  assert(String(err.message).includes("Invalid token"), "ORATS test surfaces token errors");
}
assert(html.includes("filter-toggle"), "index has collapsible filter bar");
assert(html.includes("Market Cap"), "filter panel labels market cap");
assert(html.includes("$100M+") && html.includes("$250M+") && html.includes("$500M+"), "market cap chips include mid-size floors");
assert(html.includes("Drag to rank extras"), "index explains extra-source ranking");
assert(html.includes("view-company"), "index has company view");
assert(html.includes("view-companies"), "index has companies table view");
assert(html.includes('data-nav="companies"'), "index has Companies menu link");
const appJs = await readFile(join(root, "app.js"), "utf8");
assert(appJs.includes("Days until"), "companies table has days-until column");
assert(appJs.includes("formatMdY"), "companies table formats announce dates");
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
  const oratsMissing = await fetch("http://127.0.0.1:3456/api/options/orats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const oratsMissingJson = await oratsMissing.json();
  assert(oratsMissing.status === 400 && oratsMissingJson.error, "ORATS test requires API key");
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
  const rev = await fetch("http://127.0.0.1:3456/api/revenue/AAPL");
  const revJson = await rev.json();
  assert(rev.ok && revJson.lastRevenue > 1e10 && /\$/.test(revJson.lastRevenueDisplay || ""), "last quarter revenue API");
} finally {
  shutdown();
}

if (failures.length) {
  console.error("check failed:");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("check ok");
