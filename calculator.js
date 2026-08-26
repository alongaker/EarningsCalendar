export const CONTRACT_SHARES = 100;

export function parseCalcNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function intrinsicAtExpiry(type, strike, stock) {
  if (type === "put") return Math.max(strike - stock, 0);
  return Math.max(stock - strike, 0);
}

export function pnlAtExpiry({ side, type, strike, premium, stock, contracts = 1 }) {
  const sign = side === "short" ? -1 : 1;
  const perShare = sign * (intrinsicAtExpiry(type, strike, stock) - premium);
  return perShare * CONTRACT_SHARES * Math.max(contracts, 0);
}

export function optionStats({ side, type, strike, premium, contracts = 1 }) {
  const n = Math.max(Number(contracts) || 0, 0);
  const credit = premium * CONTRACT_SHARES * n;
  const breakeven = type === "put" ? strike - premium : strike + premium;
  const long = side !== "short";
  if (type === "call") {
    return {
      breakeven,
      maxProfit: long ? null : credit,
      maxLoss: long ? credit : null,
    };
  }
  const putToZero = Math.max(strike - premium, 0) * CONTRACT_SHARES * n;
  return {
    breakeven,
    maxProfit: long ? putToZero : credit,
    maxLoss: long ? credit : putToZero,
  };
}

export function payoffSeries(input, { points = 81 } = {}) {
  const { strike, spot } = input;
  const center = spot > 0 ? spot : strike;
  const low = Math.max(0, center * 0.55);
  const high = Math.max(center * 1.45, strike * 1.2, 1);
  const step = (high - low) / Math.max(points - 1, 1);
  const rows = [];
  for (let i = 0; i < points; i += 1) {
    const stock = low + step * i;
    rows.push({ stock, pnl: pnlAtExpiry({ ...input, stock }) });
  }
  return rows;
}

export function formatCalcMoney(value) {
  if (value == null || !Number.isFinite(Number(value))) return "Unlimited";
  const n = Number(value);
  const abs = Math.abs(n);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: abs >= 100 ? 0 : 2,
  }).format(abs);
  if (n > 0) return `+${formatted}`;
  if (n < 0) return `−${formatted}`;
  return formatted;
}
