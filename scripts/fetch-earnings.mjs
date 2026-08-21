#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchUpcoming } from "./earnings-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(root, "data", "earnings.json");

const days = Number(process.env.EARNINGS_DAYS || 21);
const snapshot = await fetchUpcoming({ days });
await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, `${JSON.stringify(snapshot, null, 2)}\n`);

const errNote = snapshot.errors.length
  ? ` (${snapshot.errors.length} day(s) failed)`
  : "";
console.log(
  `Wrote ${snapshot.count} calls ${snapshot.startDate} → ${snapshot.endDate}${errNote} to data/earnings.json`
);
