#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { fetchUpcoming } from "./scripts/earnings-lib.mjs";

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
  if (cache.data && now - cache.at < CACHE_MS && cache.days === days) {
    return cache.data;
  }
  const data = await fetchUpcoming({ days });
  cache = { at: now, days, data };
  return data;
}

async function fileEarnings() {
  const file = join(root, "data", "earnings.json");
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw);
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
  res.writeHead(200, { "Content-Type": type });
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

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Earnings Calendar running at http://localhost:${PORT}`);
  console.log("Live API:  GET /api/earnings");
  console.log("Snapshot:  GET /api/earnings?live=0");
});
