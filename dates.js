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

export function windowUpcoming(snap, today = marketDateIso()) {
  const calls = (snap?.calls || []).filter((call) => call.date >= today);
  return {
    ...snap,
    startDate: calls[0]?.date || today,
    endDate: calls.at(-1)?.date || snap?.endDate || today,
    count: calls.length,
    calls,
  };
}
