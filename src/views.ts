import type { VerdictRun } from "./agent.ts";
import { lineStyle } from "./lines.ts";
import { STAGES } from "./progress.ts";
import { cleanName, stationById } from "./stations.ts";
import type { TflArrival, TflJourney, TflJourneyLeg, TflLiveCrowding } from "./tfl-types.ts";
import type { LineStatusProjection, RouteComparisonOption } from "./tfl-types.ts";
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
      <button type="button" class="clear" aria-label="Clear ${field === "from" ? "From" : "To"}" hidden></button>
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
    <section id="saved" aria-label="My stations"></section>
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
  // usualMinutes is set when the route shown is a detour, so the card can compare durations.
  route?: { journey: TflJourney; label: string; live: boolean; usualMinutes?: number };
  // Bus-only / tube-only alternatives, so a commuter can weigh cost and time against the plan.
  compare?: RouteComparisonOption[];
}

const formatFare = (pence: number | null | undefined) => (pence == null ? null : `£${(pence / 100).toFixed(2)}`);

export function verdictCard(from: string, to: string, run: VerdictRun, extras: CardExtras = {}): string {
  const v = run.verdict;
  const route = extras.route;
  const detour = route?.usualMinutes !== undefined ? route.journey.duration : undefined;
  const lost = detour !== undefined ? Math.max(0, detour - route!.usualMinutes!) : Math.round(v.minutes_lost);
  const compared = detour !== undefined ? ` (${detour} min vs ${route!.usualMinutes} normally)` : "";

  // "Disrupted, 0 min lost" reads as a contradiction. A disruption the detour absorbs is
  // real but minor, so it gets its own amber state and says the detour costs nothing.
  const status =
    run.failure || v.confidence === "low" ? "unknown" : !v.is_disrupted ? "clear" : lost < 3 ? "minor" : "disrupted";
  const headline = {
    clear: "Good service",
    minor: detour !== undefined ? "Easy detour" : "Minor disruption",
    disrupted: "Disrupted",
    unknown: "Couldn't verify",
  }[status];

  const details = [
    status === "disrupted"
      ? `<li>About <strong>${lost} min</strong> lost vs a normal day${esc(compared)}</li>`
      : "",
    status === "minor"
      ? detour !== undefined
        ? `<li>The detour takes about as long as a normal day${esc(compared)}</li>`
        : `<li>Little or no time lost vs a normal day</li>`
      : "",
    v.alternative_summary ? `<li>Alternative: ${esc(v.alternative_summary)}</li>` : "",
    `<li>Confidence: ${esc(v.confidence)}</li>`,
  ].join("");

  return `<article class="verdict" data-status="${status}">
  <header><span class="status-pill">${headline}</span> <strong>${esc(from)} → ${esc(to)}</strong></header>
  <p class="verdict-text">${esc(v.verdict)}</p>
  <ul>${details}</ul>
  ${route ? itinerary(route.journey, route.label, route.live, status !== "clear") : ""}
  ${route ? boardSlot(route.journey) : ""}
  ${extras.compare?.length ? compareTable(route, extras.compare) : ""}
  <footer><small>${(run.durationMs / 1000).toFixed(1)}s · $${run.costUsd.toFixed(4)}</small></footer>
</article>`;
}

// How this route stacks up against a bus-only or tube-only plan, so a commuter can weigh
// a few extra minutes against a cheaper or simpler journey.
function compareTable(route: CardExtras["route"], options: RouteComparisonOption[]): string {
  const rows = [
    route ? { label: route.label, duration: route.journey.duration, fareTotalCost: route.journey.fare?.totalCost ?? null } : null,
    ...options,
  ].filter((r): r is { label: string; duration: number; fareTotalCost: number | null } => r !== null);
  return `<section class="compare">
    <h3>Compare your options</h3>
    <table>
      <thead><tr><th>Option</th><th>Time</th><th>Cost</th></tr></thead>
      <tbody>${rows
        .map(
          (r) =>
            `<tr><td>${esc(r.label)}</td><td>${r.duration} min</td><td>${esc(formatFare(r.fareTotalCost) ?? "—")}</td></tr>`,
        )
        .join("")}</tbody>
    </table>
  </section>`;
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

// The stations between departurePoint and arrivalPoint, collapsed by default so a
// 20-stop Piccadilly line leg doesn't dominate the card. Rendered as a little tube map:
// a coloured line (the leg's own line) threaded through a dot per stop, with a tiny dot
// per other line an interchange stop also serves.
function stopList(leg: TflJourneyLeg): string {
  const stops = leg.path?.stopPoints ?? [];
  if (leg.mode.id === "walking" || stops.length === 0) return "";
  const legLineId = leg.routeOptions?.[0]?.lineIdentifier?.id;
  const style = lineStyle(legLineId, leg.mode.id);
  const items = stops
    .map((s) => {
      const otherLines = (stationById(s.id)?.lines ?? []).filter((l) => l !== legLineId);
      const dots = otherLines
        .map((l) => {
          const ls = lineStyle(l);
          return `<span class="tube-line-dot" style="--c:${ls.colour}" title="${esc(ls.name)}"></span>`;
        })
        .join("");
      return `<li><span class="tube-name">${esc(cleanName(s.name))}</span>${dots ? `<span class="tube-lines">${dots}</span>` : ""}</li>`;
    })
    .join("");
  return `<details class="stop-list">
    <summary>${stops.length} stop${stops.length === 1 ? "" : "s"} along the way</summary>
    <ol class="tube-stops" style="--c:${style.colour}">${items}</ol>
  </details>`;
}

// TfL flags legs isDisrupted for minor notices too; showing that under a "Good service"
// verdict contradicts the card, so leg warnings only appear when the verdict agrees.
function itinerary(journey: TflJourney, label: string, live: boolean, warnLegs: boolean): string {
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
        <div class="step-body">${esc(instruction)}${warnLegs && leg.isDisrupted ? ` <span class="warn">Disrupted</span>` : ""}</div>
        <div class="step-facts">${facts.map(esc).join(" · ")}</div>
        ${stopList(leg)}
      </li>`;
    })
    .join("");
  const last = journey.legs.at(-1)?.arrivalPoint;
  const arrive = live && journey.arrivalDateTime ? ` · arrive ${londonTime(journey.arrivalDateTime)}` : "";
  const fare = formatFare(journey.fare?.totalCost);
  return `<section class="itinerary">
    <h3>${esc(label)} <small>${journey.duration} min${arrive}${fare ? ` · ${esc(fare)} pay as you go` : ""}</small></h3>
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
    mode: leg.mode.id,
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
  mode?: string;
  towards: string;
  arrivals: TflArrival[];
  status?: LineStatusProjection;
}

// TfL sends bus arrivals with towards: "null" (the string), and tube ones with a
// "Check Front of Train" placeholder; neither is a destination.
function destinationOf(a: TflArrival): string {
  const towards = a.towards && a.towards !== "null" && !/check front of train/i.test(a.towards) ? a.towards : "";
  return towards || cleanName(a.destinationName ?? "") || "Check front of train";
}

// Loose direction match: the Journey Planner says "Crystal Palace Parade" where the
// arrivals feed says "Crystal Palace", so either may be a prefix of the other.
function sameDirection(a: string, b: string): boolean {
  const x = a.toLowerCase().trim();
  const y = b.toLowerCase().trim();
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
}

export function departureBoard(b: BoardInput): string {
  const bus = b.mode === "bus";
  const style = lineStyle(b.lineId || null, b.mode);
  const pillName = bus ? `Bus ${b.lineId}` : style.name;
  const byPlatform = new Map<string, TflArrival[]>();
  for (const a of [...b.arrivals].sort((x, y) => x.timeToStation - y.timeToStation)) {
    if (b.lineId && a.lineId !== b.lineId) continue;
    const list = byPlatform.get(a.platformName) ?? [];
    list.push(a);
    byPlatform.set(a.platformName, list);
  }

  // The commuter's platform is the one whose trains run towards the leg's direction.
  const isYours = (list: TflArrival[]) =>
    list.some((a) => sameDirection(cleanName(a.destinationName ?? ""), b.towards) || sameDirection(destinationOf(a), b.towards));
  const platforms = [...byPlatform.entries()]
    .sort(([, a], [, b2]) => Number(isYours(b2)) - Number(isYours(a)))
    .slice(0, 2);

  const approaching = !bus && platforms.some(([, list]) => isYours(list) && (list[0]?.timeToStation ?? 999) < 30);
  const rows = platforms
    .map(([name, list]) => {
      const trains = list
        .slice(0, 3)
        .map((a, i) => {
          const mins = Math.floor(a.timeToStation / 60);
          return `<div class="board-row"><span class="n">${i + 1}</span><span class="dest">${esc(destinationOf(a))}</span><span class="due">${mins < 1 ? "due" : `${mins} min`}</span></div>`;
        })
        .join("");
      const place = bus ? (name && name !== "null" ? `Stop ${name}` : "Departures") : name || "Departures";
      const yours = isYours(list) ? (bus ? " · your stop" : " · your platform") : "";
      return `<div class="platform${isYours(list) ? " yours" : ""}"><div class="plat-name">${esc(place)}${yours}</div>${trains}</div>`;
    })
    .join("");

  const worst = b.status?.statuses.find((s) => s.statusSeverity < 10);
  const ticker = approaching
    ? "*** STAND BACK — TRAIN APPROACHING ***"
    : worst
      ? `${worst.statusSeverityDescription}: ${worst.reason ?? ""}`
      : bus
        ? `Good service on route ${b.lineId}`
        : `Good service on the ${style.name || "line"}${b.lineId === "dlr" || !style.name ? "" : " line"}`;

  return `<div class="board" role="region" aria-label="Live departures at ${esc(b.stationName)}">
    <div class="board-head"><span>${esc(b.stationName)}</span>${pillName ? `<span class="pill" style="--c:${style.colour};--ink:${style.ink}">${esc(pillName)}</span>` : ""}</div>
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
