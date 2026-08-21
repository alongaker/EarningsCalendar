const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function isSymbol(value) {
  return /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(String(value || "").trim());
}

function val(field) {
  if (field === null || field === undefined) return "";
  if (typeof field === "object") return field.value ?? field.label ?? "";
  return String(field);
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
    price: primary.lastSalePrice || "",
    netChange: primary.netChange || "",
    percentageChange: primary.percentageChange || "",
    direction: primary.deltaIndicator || "",
    asOf: primary.lastTradeTimestamp || "",
    bid: primary.bidPrice || "",
    ask: primary.askPrice || "",
    volume: val(summaryData.ShareVolume) || primary.volume || "",
    averageVolume: val(summaryData.AverageVolume),
    previousClose: val(summaryData.PreviousClose),
    dayRange: val(stats.dayrange) || val(summaryData.TodayHighLow),
    week52: val(stats.fiftyTwoWeekHighLow) || val(summaryData.FiftTwoWeekHighLow),
    marketCap: val(summaryData.MarketCap),
    target: val(summaryData.OneYrTarget),
    dividend: val(summaryData.AnnualizedDividend),
    yield: val(summaryData.Yield),
    exDividend: val(summaryData.ExDividendDate),
    sector: val(profile?.Sector) || val(summaryData.Sector),
    industry: val(profile?.Industry) || val(summaryData.Industry),
    region: val(profile?.Region),
    website: val(profile?.CompanyUrl),
    description: val(profile?.CompanyDescription),
    earningsHistory: history.map((row) => ({
      fiscalQtrEnd: row.fiscalQtrEnd || "",
      dateReported: row.dateReported || "",
      eps: row.eps ?? "",
      consensus: row.consensusForecast || "",
      surprise: row.percentageSurprise || "",
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
