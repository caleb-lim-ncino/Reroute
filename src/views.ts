import type { VerdictRun } from "./agent.ts";
import { lineStyle } from "./lines.ts";
import { STAGES } from "./progress.ts";
import { cleanName } from "./stations.ts";
import type { TflArrival, TflJourney, TflJourneyLeg, TflLiveCrowding } from "./tfl-types.ts";
import type { LineStatusProjection } from "./tfl-types.ts";
import type { usageSummary } from "./usage.ts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ROUNDEL = `<svg class="roundel" viewBox="0 0 100 80" aria-hidden="true">
  <circle cx="50" cy="40" r="31" fill="none" stroke="#DC241F" stroke-width="15"/>
  <rect x="4" y="31" width="92" height="18" fill="#0019A8"/>
  <text x="50" y="44.5" text-anchor="middle" font-size="12" font-weight="700" fill="#fff" font-family="system-ui, sans-serif" letter-spacing=".5">REROUTE</text>
</svg>`;

// A 1973-stock-ish side view: red doors band, white body, blue skirt.
const TRAIN = `<svg viewBox="0 0 64 24" aria-hidden="true">
  <rect x="1" y="3" width="60" height="16" rx="6" fill="#fff" stroke="#111" stroke-width="1.5"/>
  <rect x="1" y="13" width="60" height="4" fill="#0019A8"/>
  <rect x="6" y="6" width="7" height="6" rx="1" fill="#DC241F"/>
  <rect x="17" y="6" width="9" height="5" rx="1" fill="#9ad"/>
  <rect x="30" y="6" width="9" height="5" rx="1" fill="#9ad"/>
  <rect x="43" y="6" width="7" height="6" rx="1" fill="#DC241F"/>
  <rect x="54" y="6" width="5" height="5" rx="2" fill="#9ad"/>
  <circle cx="14" cy="21" r="2.5" fill="#111"/><circle cx="48" cy="21" r="2.5" fill="#111"/>
</svg>`;

function combo(field: "from" | "to", placeholder: string): string {
  return `<div class="combo" data-field="${field}">
      <label for="${field}">${field === "from" ? "From" : "To"}</label>
      <input id="${field}" name="${field}" placeholder="${placeholder}" required autocomplete="off" spellcheck="false"
        role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${field}-list">
      <input type="hidden" name="${field}Id">
      <ul id="${field}-list" class="suggestions" role="listbox" hidden></ul>
      <div class="picked" aria-live="polite"></div>
    </div>`;
}

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reroute</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700;900&display=swap">
  <link rel="stylesheet" href="/static/app.css">
  <script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
  <script src="/static/app.js" defer></script>
</head>
<body>
  <header>
    <div class="brand">${ROUNDEL}<div><h1>Reroute</h1><p>Does your usual Tube route still hold up right now?</p></div></div>
  </header>
  <main>
    <nav id="saved" aria-label="Saved stations"></nav>
    <form id="plan" hx-post="/plan" hx-target="#result" hx-indicator="#checking" hx-disabled-elt="find button[type=submit]">
      <div class="route-inputs">
        ${combo("from", "e.g. Canada Water")}
        <button type="button" class="swap secondary" aria-label="Swap from and to" title="Swap">⇅</button>
        ${combo("to", "e.g. Canary Wharf")}
      </div>
      <input type="hidden" name="rid">
      <button type="submit">Check my route</button>
    </form>
    ${loader()}
    <section id="result"></section>
  </main>
  <footer id="usage" hx-get="/usage" hx-trigger="load, every 10s, verdict from:body"></footer>
</body>
</html>`;
}

function loader(): string {
  const stops = STAGES.map((s) => `<li><span class="dot"></span><span class="label">${esc(s)}</span></li>`).join("");
  return `<div id="checking" class="htmx-indicator loader" role="status" aria-live="polite">
      <div class="loader-head">
        <span class="line-badge">Reroute line</span>
        <span>Next stop: <strong class="next-stop">${esc(STAGES[0]!)}</strong></span>
      </div>
      <div class="track" style="--pos:0">
        <div class="rail"><div class="rail-fill"></div></div>
        <ol class="stops">${stops}</ol>
        <div class="train">${TRAIN}</div>
      </div>
      <p class="quip">Minding the gap…</p>
      <p class="loader-stats"><span class="gauge-pct">0%</span> of the way · <span class="elapsed">0.0</span>s</p>
    </div>`;
}

// ---- verdict card -------------------------------------------------------------------

export interface CardExtras {
  route?: { journey: TflJourney; label: string; live: boolean };
}

export function verdictCard(from: string, to: string, run: VerdictRun, extras: CardExtras = {}): string {
  const v = run.verdict;
  const status = run.failure || v.confidence === "low" ? "unknown" : v.is_disrupted ? "disrupted" : "clear";
  const headline = { clear: "Good service", disrupted: "Disrupted", unknown: "Couldn't verify" }[status];

  const details = [
    v.is_disrupted ? `<li>About <strong>${v.minutes_lost} min</strong> lost vs a normal day</li>` : "",
    v.alternative_summary ? `<li>Alternative: ${esc(v.alternative_summary)}</li>` : "",
    `<li>Confidence: ${esc(v.confidence)}</li>`,
  ].join("");

  const route = extras.route;
  return `<article class="verdict" data-status="${status}">
  <header><span class="status-pill">${headline}</span> <strong>${esc(from)} → ${esc(to)}</strong></header>
  <p class="verdict-text">${esc(v.verdict)}</p>
  <ul>${details}</ul>
  ${route ? itinerary(route.journey, route.label, route.live) : ""}
  ${route ? boardSlot(route.journey) : ""}
  <footer><small>${(run.durationMs / 1000).toFixed(1)}s · $${run.costUsd.toFixed(4)}</small></footer>
</article>`;
}

const londonTime = (iso?: string) => (iso ? iso.slice(11, 16) : "");
const isUnderground = (id?: string) => !!id && id.startsWith("940G");

function legPill(leg: TflJourneyLeg): string {
  const lineId = leg.routeOptions?.[0]?.lineIdentifier?.id;
  const style = lineStyle(lineId, leg.mode.id);
  const label = leg.mode.id === "bus" ? `Bus ${leg.routeOptions?.[0]?.name ?? ""}` : style.name || leg.mode.name;
  return `<span class="pill" style="--c:${style.colour};--ink:${style.ink}">${esc(label.trim())}</span>`;
}

function crowdSlot(naptanId?: string): string {
  if (!isUnderground(naptanId)) return "";
  return `<span class="crowd-slot" hx-get="/crowding/${encodeURIComponent(naptanId!)}" hx-trigger="load" hx-swap="innerHTML"></span>`;
}

function itinerary(journey: TflJourney, label: string, live: boolean): string {
  const steps = journey.legs
    .map((leg) => {
      const lineId = leg.routeOptions?.[0]?.lineIdentifier?.id;
      const style = lineStyle(lineId, leg.mode.id);
      const stops = leg.path?.stopPoints?.length ?? 0;
      const facts = [
        live && leg.departureTime ? londonTime(leg.departureTime) : "",
        `${leg.duration} min`,
        leg.mode.id !== "walking" && stops ? `${stops} stop${stops === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      const instruction = leg.instruction?.detailed ?? leg.instruction?.summary ?? "";
      return `<li style="--c:${style.colour}">
        <div class="step-head">${legPill(leg)} <span class="step-from">${esc(cleanName(leg.departurePoint.commonName))}</span> ${crowdSlot(leg.departurePoint.naptanId)}</div>
        <div class="step-body">${esc(instruction)}${leg.isDisrupted ? ` <span class="warn">Disrupted</span>` : ""}</div>
        <div class="step-facts">${facts.map(esc).join(" · ")}</div>
      </li>`;
    })
    .join("");
  const last = journey.legs.at(-1)?.arrivalPoint;
  const arrive = live && journey.arrivalDateTime ? ` · arrive ${londonTime(journey.arrivalDateTime)}` : "";
  return `<section class="itinerary">
    <h3>${esc(label)} <small>${journey.duration} min${arrive}</small></h3>
    <ol class="steps">${steps}
      <li class="end"><div class="step-head"><span class="step-from">${esc(cleanName(last?.commonName ?? ""))}</span> ${crowdSlot(last?.naptanId)}</div></li>
    </ol>
  </section>`;
}

// The departure board for where the commuter actually boards: the first leg they ride.
function boardSlot(journey: TflJourney): string {
  const leg = journey.legs.find((l) => l.mode.id !== "walking");
  const stopId = leg?.departurePoint.naptanId;
  if (!leg || !stopId) return "";
  const params = new URLSearchParams({
    line: leg.routeOptions?.[0]?.lineIdentifier?.id ?? "",
    towards: cleanName(leg.routeOptions?.[0]?.directions?.[0] ?? ""),
    name: cleanName(leg.departurePoint.commonName),
  });
  return `<section class="board-wrap">
    <h3>Live departures</h3>
    <div hx-get="/board/${encodeURIComponent(stopId)}?${esc(params.toString())}" hx-trigger="load, every 20s" hx-swap="innerHTML">
      <div class="board"><div class="board-row">Loading departures…</div></div>
    </div>
  </section>`;
}

// ---- departure board fragment ---------------------------------------------------------

export interface BoardInput {
  stationName: string;
  lineId: string;
  towards: string;
  arrivals: TflArrival[];
  status?: LineStatusProjection;
}

function destinationOf(a: TflArrival): string {
  const towards = a.towards && !/check front of train/i.test(a.towards) ? a.towards : "";
  return towards || cleanName(a.destinationName ?? "") || "Check front of train";
}

export function departureBoard(b: BoardInput): string {
  const style = lineStyle(b.lineId || null);
  const byPlatform = new Map<string, TflArrival[]>();
  for (const a of [...b.arrivals].sort((x, y) => x.timeToStation - y.timeToStation)) {
    if (b.lineId && a.lineId !== b.lineId) continue;
    const list = byPlatform.get(a.platformName) ?? [];
    list.push(a);
    byPlatform.set(a.platformName, list);
  }

  // The commuter's platform is the one whose trains run towards the leg's direction.
  const towards = b.towards.toLowerCase();
  const isYours = (list: TflArrival[]) =>
    !!towards && list.some((a) => cleanName(a.destinationName ?? "").toLowerCase() === towards || destinationOf(a).toLowerCase().startsWith(towards));
  const platforms = [...byPlatform.entries()]
    .sort(([, a], [, b2]) => Number(isYours(b2)) - Number(isYours(a)))
    .slice(0, 2);

  const approaching = platforms.some(([, list]) => isYours(list) && (list[0]?.timeToStation ?? 999) < 30);
  const rows = platforms
    .map(([name, list]) => {
      const trains = list
        .slice(0, 3)
        .map((a, i) => {
          const mins = Math.floor(a.timeToStation / 60);
          return `<div class="board-row"><span class="n">${i + 1}</span><span class="dest">${esc(destinationOf(a))}</span><span class="due">${mins < 1 ? "due" : `${mins} min`}</span></div>`;
        })
        .join("");
      return `<div class="platform${isYours(list) ? " yours" : ""}"><div class="plat-name">${esc(name || "Departures")}${isYours(list) ? " · your platform" : ""}</div>${trains}</div>`;
    })
    .join("");

  const worst = b.status?.statuses.find((s) => s.statusSeverity < 10);
  const ticker = approaching
    ? "*** STAND BACK — TRAIN APPROACHING ***"
    : worst
      ? `${worst.statusSeverityDescription}: ${worst.reason ?? ""}`
      : `Good service on the ${style.name || "line"}${b.lineId === "dlr" || !style.name ? "" : " line"}`;

  return `<div class="board" role="region" aria-label="Live departures at ${esc(b.stationName)}">
    <div class="board-head"><span>${esc(b.stationName)}</span>${style.name ? `<span class="pill" style="--c:${style.colour};--ink:${style.ink}">${esc(style.name)}</span>` : ""}</div>
    ${rows || `<div class="board-row"><span class="dest">No departures shown</span></div>`}
    <div class="board-foot"><div class="ticker${worst || approaching ? " alert" : ""}"><span>${esc(ticker)}</span></div><span class="board-clock" data-clock></span></div>
  </div>`;
}

// ---- crowding chip -------------------------------------------------------------------

export function crowdingChip(c: TflLiveCrowding | undefined): string {
  if (!c?.dataAvailable) return "";
  const pct = Math.round(c.percentageOfBaseline * 100);
  const [level, label] =
    c.percentageOfBaseline < 0.35
      ? ["quiet", "Quiet"]
      : c.percentageOfBaseline < 0.65
        ? ["moderate", "Moderate"]
        : c.percentageOfBaseline < 0.9
          ? ["busy", "Busy"]
          : ["packed", "Very busy"];
  return `<span class="crowd crowd-${level}" title="Live crowding: ${pct}% of this station's usual busiest">
    <span class="crowd-bars" style="--fill:${Math.min(pct, 100)}%"></span>${label} · ${pct}%</span>`;
}

export function usageFooter(u: ReturnType<typeof usageSummary>): string {
  if (u.requests === 0) return `<small>No model calls yet.</small>`;
  const perModel = u.models
    .map((m) => {
      const name = m.model.split("/").pop() ?? m.model;
      return `<small>${esc(name)}: ${m.calls} calls · ${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out · $${m.costUsd.toFixed(4)}</small>`;
    })
    .join("");
  return `<small><strong>Model spend this session: $${u.costUsd.toFixed(4)}</strong> across ${u.requests} calls</small>${perModel}`;
}
