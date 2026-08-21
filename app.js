const TIME_LABEL = {
  "before-open": "Before open",
  "after-close": "After close",
  unspecified: "Time TBD",
};

const state = {
  snapshot: null,
  query: "",
  time: "all",
  minCap: 0,
  day: "all",
};

const els = {
  asOf: document.querySelector("#as-of"),
  source: document.querySelector("#source-line"),
  week: document.querySelector("#week"),
  board: document.querySelector("#board"),
  q: document.querySelector("#q"),
};

function fmtDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function weekday(iso) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  }).format(fmtDate(iso));
}

function longDate(iso) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(fmtDate(iso));
}

function shortDate(iso) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(fmtDate(iso));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function matches(call) {
  const q = state.query.trim().toLowerCase();
  if (q && !`${call.symbol} ${call.name}`.toLowerCase().includes(q)) return false;
  if (state.time !== "all" && call.time !== state.time) return false;
  if (call.marketCap < state.minCap) return false;
  if (state.day !== "all" && call.date !== state.day) return false;
  return true;
}

function groupByDate(calls) {
  const map = new Map();
  for (const call of calls) {
    if (!map.has(call.date)) map.set(call.date, []);
    map.get(call.date).push(call);
  }
  return [...map.entries()];
}

function renderWeek(allCalls, filtered) {
  const counts = new Map();
  for (const call of allCalls) {
    counts.set(call.date, (counts.get(call.date) || 0) + 1);
  }
  const days = [...counts.keys()].sort();
  const visible = new Set(filtered.map((c) => c.date));
  els.week.innerHTML = [
    `<button class="day-pill ${state.day === "all" ? "is-on" : ""}" data-day="all" type="button">
      <span class="day-pill__name">All days</span>
      <span class="day-pill__count">${filtered.length}</span>
    </button>`,
    ...days.map((date) => {
      const on = state.day === date ? "is-on" : "";
      const n = filtered.filter((c) => c.date === date).length;
      const faded = visible.has(date) ? "" : ' style="opacity:.45"';
      return `<button class="day-pill ${on}" data-day="${date}" type="button"${faded}>
        <span class="day-pill__name">${shortDate(date)}</span>
        <span class="day-pill__count">${n}</span>
      </button>`;
    }),
  ].join("");
}

function renderBoard(calls) {
  if (!calls.length) {
    els.board.innerHTML = `<p class="empty">No calls match those filters.</p>`;
    return;
  }
  els.board.innerHTML = groupByDate(calls)
    .map(([date, rows]) => {
      const body = rows
        .map(
          (call) => `<tr>
            <td><span class="time-badge ${call.time}">${TIME_LABEL[call.time]}</span></td>
            <td class="symbol">${escapeHtml(call.symbol)}</td>
            <td>
              <div>${escapeHtml(call.name)}</div>
              <div class="company hide-sm">${escapeHtml(call.fiscalQuarterEnding || "")}</div>
            </td>
            <td class="num">${escapeHtml(call.marketCapDisplay)}</td>
            <td class="num hide-sm">${escapeHtml(call.epsForecast || "—")}</td>
            <td class="num hide-sm">${call.estimateCount || "—"}</td>
          </tr>`
        )
        .join("");
      return `<section class="day-block" id="day-${date}">
        <div class="day-head">
          <h3>${weekday(date)}</h3>
          <span>${longDate(date)} · ${rows.length} call${rows.length === 1 ? "" : "s"}</span>
        </div>
        <table class="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Ticker</th>
              <th>Company</th>
              <th>Cap</th>
              <th class="hide-sm">EPS est.</th>
              <th class="hide-sm"># est.</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </section>`;
    })
    .join("");
}

function render() {
  const snap = state.snapshot;
  if (!snap) return;
  const filtered = snap.calls.filter(matches);
  const generated = new Date(snap.generatedAt);
  const when = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(generated);
  els.asOf.textContent = `${snap.count} calls · ${snap.startDate} to ${snap.endDate} · updated ${when}`;
  els.source.textContent = snap.warning
    ? `${snap.sourceLabel} · ${snap.warning}`
    : `${snap.sourceLabel}${snap.mode === "live" ? " · live" : " · snapshot"}`;
  const weekCalls = snap.calls.filter((call) => {
    const q = state.query.trim().toLowerCase();
    if (q && !`${call.symbol} ${call.name}`.toLowerCase().includes(q)) return false;
    if (state.time !== "all" && call.time !== state.time) return false;
    if (call.marketCap < state.minCap) return false;
    return true;
  });
  renderWeek(snap.calls, weekCalls);
  renderBoard(filtered);
}

async function loadSnapshot() {
  const res = await fetch("./data/earnings.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.json();
}

async function loadLive() {
  const res = await fetch("/api/earnings?days=21", { cache: "no-store" });
  if (!res.ok) throw new Error(`live ${res.status}`);
  return res.json();
}

async function load() {
  try {
    state.snapshot = await loadSnapshot();
    state.snapshot.mode = state.snapshot.mode || "snapshot";
    render();
  } catch (err) {
    els.asOf.textContent = "Loading live calendar…";
  }

  try {
    const live = await loadLive();
    state.snapshot = live;
    render();
  } catch (err) {
    if (!state.snapshot) throw err;
  }
}

document.querySelectorAll("[data-time]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-time]").forEach((b) => b.classList.toggle("is-on", b === btn));
    state.time = btn.dataset.time;
    render();
  });
});

document.querySelectorAll("[data-cap]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-cap]").forEach((b) => b.classList.toggle("is-on", b === btn));
    state.minCap = Number(btn.dataset.cap);
    render();
  });
});

els.week.addEventListener("click", (event) => {
  const btn = event.target.closest("[data-day]");
  if (!btn) return;
  state.day = btn.dataset.day;
  render();
});

els.q.addEventListener("input", () => {
  state.query = els.q.value;
  render();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && document.activeElement !== els.q) {
    event.preventDefault();
    els.q.focus();
  }
});

load().catch((err) => {
  els.board.innerHTML = `<p class="empty">Could not load earnings data. ${escapeHtml(err.message)}</p>`;
});
