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
    name: val(profile?.CompanyName) || info?.companyName || "",
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
  const ticker = String(symbol || "").trim().toUpperCase();
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
