#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { normalizeRow, parseMarketCap, formatMarketCap } from "./earnings-lib.mjs";

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

const html = await readFile(join(root, "index.html"), "utf8");
assert(html.includes("Earnings Calendar"), "index has title");
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
} finally {
  shutdown();
}

if (failures.length) {
  console.error("check failed:");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("check ok");
