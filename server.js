#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { fetchUpcoming } from "./scripts/earnings-lib.mjs";
import { fetchProvider, providerIds, testOratsKey, fetchOratsSnapshot, windowUpcoming, marketDateIso } from "./providers.js";
import {
  fetchCompanyBundle,
  fetchNasdaqQuoteLite,
  fetchNasdaqPrice,
  fetchLastQuarterRevenue,
  isSymbol,
} from "./company.js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

let cache = { at: 0, data: null };
const CACHE_MS = 10 * 60 * 1000;
const companyCache = new Map();

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function apiKeyFrom(req, body) {
  return (
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    body.apiKey ||
    body.key ||
    ""
  );
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function sendText(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

async function liveEarnings(query) {
  const days = Math.min(45, Math.max(1, Number(query.get("days") || 21)));
  const now = Date.now();
  const today = marketDateIso();
  if (cache.data && now - cache.at < CACHE_MS && cache.days === days && cache.today === today) {
    return cache.data;
  }
  const data = await fetchUpcoming({ days });
  cache = { at: now, days, today, data };
  return data;
}

async function fileEarnings() {
  const file = join(root, "data", "earnings.json");
  const raw = await readFile(file, "utf8");
  return windowUpcoming(JSON.parse(raw));
}

function safeFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const rel = clean === "/" ? "/index.html" : clean;
  const resolved = resolve(root, `.${normalize(`/${rel}`)}`);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  if (resolved.includes(`${sep}.git${sep}`) || resolved.endsWith(`${sep}.git`)) {
    return null;
  }
  return resolved;
}

function serveStatic(req, res) {
  const file = safeFile(req.url || "/");
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  const type = MIME[extname(file)] || "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (url.pathname === "/api/earnings") {
    try {
      const live = url.searchParams.get("live") !== "0";
      const data = live ? await liveEarnings(url.searchParams) : await fileEarnings();
      sendJson(res, 200, { ...data, mode: live ? "live" : "snapshot" });
    } catch (err) {
      try {
        const fallback = await fileEarnings();
        sendJson(res, 200, {
          ...fallback,
          mode: "snapshot",
          warning: `Live fetch failed: ${err.message}`,
        });
      } catch {
        sendJson(res, 502, { error: err.message });
      }
    }
    return;
  }

  const companyMatch = url.pathname.match(/^\/api\/company\/([^/]+)$/);
  if (companyMatch && req.method === "GET") {
    const symbol = decodeURIComponent(companyMatch[1] || "").toUpperCase();
    if (!isSymbol(symbol)) {
      sendJson(res, 400, { error: "Invalid symbol" });
      return;
    }
    try {
      const now = Date.now();
      const hit = companyCache.get(symbol);
      if (hit && now - hit.at < CACHE_MS) {
        sendJson(res, 200, hit.data);
        return;
      }
      const data = await fetchCompanyBundle(symbol);
      companyCache.set(symbol, { at: now, data });
      sendJson(res, 200, data);
    } catch (err) {
      sendJson(res, 502, { error: err.message || "Company lookup failed" });
    }
    return;
  }

  const quoteMatch = url.pathname.match(/^\/api\/quote\/([^/]+)$/);
  if (quoteMatch && req.method === "GET") {
    const symbol = decodeURIComponent(quoteMatch[1] || "").toUpperCase();
    if (!isSymbol(symbol)) {
      sendJson(res, 400, { error: "Invalid symbol" });
      return;
    }
    try {
      const data = await fetchNasdaqQuoteLite(symbol, {
        withEps: url.searchParams.get("eps") === "1",
      });
      if (!data) {
        sendJson(res, 404, { error: "Quote not found" });
        return;
      }
      sendJson(res, 200, data);
    } catch (err) {
      sendJson(res, 502, { error: err.message || "Quote lookup failed" });
    }
    return;
  }

  const priceMatch = url.pathname.match(/^\/api\/price\/([^/]+)$/);
  if (priceMatch && req.method === "GET") {
    const symbol = decodeURIComponent(priceMatch[1] || "").toUpperCase();
    if (!isSymbol(symbol)) {
      sendJson(res, 400, { error: "Invalid symbol" });
      return;
    }
    try {
      const data = await fetchNasdaqPrice(symbol);
      if (!data?.price) {
        sendJson(res, 404, { error: "Price not found" });
        return;
      }
      sendJson(res, 200, data);
    } catch (err) {
      sendJson(res, 502, { error: err.message || "Price lookup failed" });
    }
    return;
  }

  const revenueMatch = url.pathname.match(/^\/api\/revenue\/([^/]+)$/);
  if (revenueMatch && req.method === "GET") {
    const symbol = decodeURIComponent(revenueMatch[1] || "").toUpperCase();
    if (!isSymbol(symbol)) {
      sendJson(res, 400, { error: "Invalid symbol" });
      return;
    }
    try {
      const data = await fetchLastQuarterRevenue(symbol);
      sendJson(res, 200, { symbol, ...data });
    } catch (err) {
      sendJson(res, 502, { error: err.message || "Revenue lookup failed" });
    }
    return;
  }

  const providerMatch = url.pathname.match(/^\/api\/provider\/([a-z]+)$/);
  if (providerMatch && req.method === "POST") {
    const id = providerMatch[1];
    if (!providerIds().includes(id)) {
      sendJson(res, 404, { error: `Unknown provider: ${id}` });
      return;
    }
    try {
      const body = await readJson(req);
      const apiKey = apiKeyFrom(req, body);
      if (!String(apiKey).trim()) {
        sendJson(res, 400, { error: "API key required" });
        return;
      }
      const from = body.from || url.searchParams.get("from");
      const to = body.to || url.searchParams.get("to");
      if (!from || !to) {
        sendJson(res, 400, { error: "from and to dates required" });
        return;
      }
      const calls = await fetchProvider(id, apiKey, { from, to });
      sendJson(res, 200, { provider: id, count: calls.length, calls });
    } catch (err) {
      sendJson(res, 502, { error: err.message || "Provider request failed" });
    }
    return;
  }

  if (url.pathname === "/api/options/orats" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const apiKey = apiKeyFrom(req, body);
      if (!String(apiKey).trim()) {
        sendJson(res, 400, { error: "API key required" });
        return;
      }
      const ticker = String(body.ticker || "").trim().toUpperCase();
      if (ticker) {
        if (!isSymbol(ticker)) {
          sendJson(res, 400, { error: "Invalid ticker" });
          return;
        }
        const snapshot = await fetchOratsSnapshot(apiKey, ticker);
        sendJson(res, 200, snapshot);
        return;
      }
      const result = await testOratsKey(apiKey);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, { error: err.message || "ORATS request failed" });
    }
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Earnings Calendar running at http://localhost:${PORT}`);
  console.log("Live API:  GET /api/earnings");
  console.log("Provider: POST /api/provider/{finnhub|fmp|alphavantage|apininjas|eodhd|twelvedata}");
  console.log("Options:  POST /api/options/orats");
  console.log("Company:  GET  /api/company/NVDA");
  console.log("Quote:    GET  /api/quote/NVDA");
  console.log("Price:   GET  /api/price/NVDA");
  console.log("Revenue: GET  /api/revenue/AAPL");
});
