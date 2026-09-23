import type { VerdictRun } from "./agent.ts";
import type { Verdict } from "./schema.ts";
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

// Line icons, feather-style (stroke=currentColor), one per profile link so the
// dropdown scans like a menu rather than a list of bare text links.
const LINK_ICONS = {
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/></svg>`,
  workday: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>`,
  // Official marks (GitHub's own octicon, Slack's via simple-icons), traced exactly rather than approximated.
  github: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`,
  slack: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>`,
};

const SWAP_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/></svg>`;

const WALK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13" cy="4" r="1.6"/><path d="m9 21 2.5-6 2.5 2.5V21M11.5 15 12 9l-3 1.5V14M12 9l3 3.5 2.5.5"/></svg>`;

const GO_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

// Both icons are always in the DOM; CSS shows the one for the theme you'd switch *to*.
function themeToggle(): string {
  return `<button type="button" class="theme-toggle" aria-label="Switch to dark mode" title="Toggle dark mode">
    <svg class="to-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
    <svg class="to-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
  </button>`;
}

function profileLink(icon: keyof typeof LINK_ICONS, label: string, href: string, external = true): string {
  return `<li><a href="${esc(href)}"${external ? ` target="_blank" rel="noopener"` : ""}><span class="link-icon">${LINK_ICONS[icon]}</span>${esc(label)}</a></li>`;
}

function profileWidget(): string {
  const photo =
    "https://avatar-management--avatars.us-west-2.prod.public.atl-paas.net/712020:cb6016a1-b4a7-4694-9440-9a98b39fe727/33d50698-1ab5-40ac-887a-9c12422cbac1/128";
  return `<div class="profile">
    <img class="ncino-logo on-light" src="/static/ncino-logo.svg" alt="nCino" width="93" height="24">
    <img class="ncino-logo on-dark" src="/static/ncino-logo-dark.svg" alt="nCino" width="93" height="24">
    <button type="button" class="profile-toggle" aria-haspopup="true" aria-expanded="false" aria-controls="profile-card">
      <img class="avatar" src="${esc(photo)}" alt="" width="36" height="36">
      <span class="profile-name">Caleb Lim</span>
    </button>
    <div id="profile-card" class="profile-card" role="menu" hidden>
      <div class="profile-card-head">
        <img class="avatar avatar-lg" src="${esc(photo)}" alt="" width="56" height="56">
        <div>
          <div class="profile-title">Caleb Lim</div>
          <div class="profile-role">Associate Software Engineer</div>
          <div class="profile-team">Engineering &ndash; EMEA &ndash; Onboarding</div>
        </div>
      </div>
      <ul class="profile-links">
        ${profileLink("mail", "caleb.lim@ncino.com", "mailto:caleb.lim@ncino.com", false)}
        ${profileLink("workday", "Workday profile", "https://wd5.myworkday.com/ncino/d/inst/PLACEHOLDER/rel-task/PLACEHOLDER.htmld")}
        ${profileLink("github", "GitHub", "https://github.com/caleb-lim-ncino")}
        ${profileLink("slack", "Slack", "https://ncino.slack.com/team/U0BTQ21PPNC")}
      </ul>
    </div>
  </div>`;
}

function combo(field: "from" | "to", placeholder: string): string {
  return `<div class="combo" data-field="${field}">
      <label for="${field}">${field === "from" ? "From" : "To"}</label>
      <div class="input-wrap">
        <input id="${field}" name="${field}" placeholder="${placeholder}" required autocomplete="off" spellcheck="false"
          role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${field}-list">
        <button type="button" class="clear" aria-label="Clear ${field === "from" ? "From" : "To"}" hidden></button>
      </div>
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
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#ffffff">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <title>Reroute</title>
  <script>
    // Resolve the theme before first paint so there's no flash of the wrong one.
    (() => {
      let t = null;
      try { t = localStorage.getItem("reroute.theme"); } catch {}
      if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      document.documentElement.dataset.theme = t;
      document.querySelector('meta[name="theme-color"]').content = t === "dark" ? "#11151c" : "#ffffff";
    })();
  </script>
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Doto:wght@700;900&display=swap">
  <link rel="stylesheet" href="/static/app.css">
  <script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
  <script src="/static/app.js" defer></script>
</head>
<body>
  <header class="topbar">
    <div class="brand">${ROUNDEL}<div><h1>Reroute</h1><p>Does your usual Tube route still hold up right now?</p></div></div>
    <div class="topbar-actions">
      ${themeToggle()}
      ${profileWidget()}
    </div>
  </header>
  <main>
    <section id="saved" aria-label="My stations"></section>
    <form id="plan" hx-post="/plan" hx-target="#result" hx-indicator="#checking" hx-disabled-elt="find button[type=submit]">
      <h2 class="form-title">Plan a journey</h2>
      <div class="route-inputs">
        ${combo("from", "e.g. Canada Water")}
        <button type="button" class="swap" aria-label="Swap from and to" title="Swap">${SWAP_ICON}</button>
        ${combo("to", "e.g. Canary Wharf")}
      </div>
      <input type="hidden" name="rid">
      <button type="submit" class="go"><span>Check my route</span>${GO_ICON}</button>
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
        <button type="button" class="cancel-check">Cancel</button>
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

// Confidence has no numeric scale of its own (schema.ts only defines low/medium/high), so it's
// mapped to a 3-step dot gauge here for a scannable visual instead of the bare word.
const CONFIDENCE_STEPS = { low: 1, medium: 2, high: 3 } as const;

function confidenceGauge(confidence: Verdict["confidence"]): string {
  const level = CONFIDENCE_STEPS[confidence];
  const dots = [1, 2, 3]
    .map((i) => `<span class="gauge-dot${i <= level ? " filled" : ""}"></span>`)
    .join("");
  return `<span class="confidence-gauge" data-level="${esc(confidence)}" role="img" aria-label="Confidence: ${esc(confidence)}">${dots}<small>${esc(confidence)}</small></span>`;
}

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

  const note =
    status === "minor"
      ? detour !== undefined
        ? `The detour takes about as long as a normal day${compared}.`
        : "Little or no time lost vs a normal day."
      : status === "disrupted" && compared
        ? `About ${lost} min lost vs a normal day${compared}.`
        : "";

  return `<article class="verdict" data-status="${status}">
  <header class="verdict-hero">
    <div class="hero-top"><span class="status-pill">${headline}</span><span class="hero-route">${esc(from)} <span aria-hidden="true">→</span><span class="sr-only">to</span> ${esc(to)}</span></div>
    <p class="verdict-text">${esc(v.verdict)}</p>
    ${route ? facts(route.journey, route.live, status === "disrupted" ? lost : undefined) : ""}
    ${route ? lineStrip(route.journey) : ""}
  </header>
  ${note || v.alternative_summary ? `<div class="verdict-notes">${note ? `<p>${esc(note)}</p>` : ""}${v.alternative_summary ? `<p><strong>Alternative:</strong> ${esc(v.alternative_summary)}</p>` : ""}</div>` : ""}
  ${route ? `<div class="verdict-body">${boardSlot(route.journey)}${itinerary(route.journey, route.label, route.live, status !== "clear")}</div>` : ""}
  ${extras.compare?.length ? compareOptions(route, extras.compare) : ""}
  <footer class="verdict-meta">
    <div class="meta-stat">${confidenceGauge(v.confidence)}</div>
    <div class="meta-stat"><small>Checked in</small><span>${(run.durationMs / 1000).toFixed(1)}s</span></div>
    <div class="meta-stat"><small>Cost</small><span>$${run.costUsd.toFixed(4)}</span></div>
  </footer>
</article>`;
}

// The four numbers a commuter actually scans for, big enough to read at arm's length.
function facts(journey: TflJourney, live: boolean, lost: number | undefined): string {
  const fare = formatFare(journey.fare?.totalCost);
  const leave = live ? londonTime(journey.legs[0]?.departureTime ?? journey.startDateTime) : "";
  const arrive = live ? londonTime(journey.arrivalDateTime) : "";
  const items = [
    leave ? ["Leave", leave] : null,
    arrive ? ["Arrive", arrive] : null,
    ["Takes", `${journey.duration}<small>min</small>`],
    lost !== undefined && lost > 0 ? ["Delay", `+${lost}<small>min</small>`, "bad"] : null,
    fare ? ["Fare", esc(fare)] : null,
  ].filter((x): x is string[] => x !== null);
  return `<dl class="facts">${items
    .map(([k, v, tone]) => `<div${tone ? ` class="${tone}"` : ""}><dt>${k}</dt><dd>${v}</dd></div>`)
    .join("")}</dl>`;
}

// The journey's shape in one row, Citymapper-style: line pills with walks in between.
function lineStrip(journey: TflJourney): string {
  const parts = journey.legs.map((leg) =>
    leg.mode.id === "walking"
      ? `<span class="walk" title="Walk ${leg.duration} min">${WALK_ICON}${leg.duration}</span>`
      : legPill(leg),
  );
  return `<div class="line-strip">${parts.join(`<span class="strip-sep" aria-hidden="true">›</span>`)}</div>`;
}

const signed = (n: number, unit: (x: number) => string) => (n === 0 ? "same" : `${n > 0 ? "+" : "−"}${unit(Math.abs(n))}`);

// How this route stacks up against a bus-only or tube-only plan, so a commuter can weigh
// a few extra minutes against a cheaper or simpler journey. Each option expands into its
// own step-by-step itinerary — the full journey was already fetched, so opening it is free.
function compareOptions(route: CardExtras["route"], options: RouteComparisonOption[]): string {
  const baseTime = route?.journey.duration;
  const baseFare = route?.journey.fare?.totalCost ?? null;
  const current = route
    ? `<li class="option current"><div class="opt-row">
        <span class="opt-label">${esc(route.label)}${lineStrip(route.journey)}</span>
        <span class="opt-num"><span><strong>${route.journey.duration} min</strong></span><span><small>${esc(formatFare(baseFare) ?? "—")}</small></span></span>
      </div></li>`
    : "";
  const rest = options
    .map((o) => {
      const dt = baseTime !== undefined ? `<em class="${o.duration > baseTime ? "worse" : o.duration < baseTime ? "better" : ""}">${signed(o.duration - baseTime, (x) => `${x} min`)}</em>` : "";
      const df =
        baseFare !== null && o.fareTotalCost !== null
          ? `<em class="${o.fareTotalCost > baseFare ? "worse" : o.fareTotalCost < baseFare ? "better" : ""}">${signed(o.fareTotalCost - baseFare, (x) => formatFare(x)!)}</em>`
          : "";
      return `<li class="option"><details>
        <summary class="opt-row">
          <span class="opt-label">${esc(o.label)}${lineStrip(o.journey)}</span>
          <span class="opt-num"><span>${dt}<strong>${o.duration} min</strong></span><span>${df}<small>${esc(formatFare(o.fareTotalCost) ?? "—")}</small></span></span>
        </summary>
        ${stepsList(o.journey, true, true)}
      </details></li>`;
    })
    .join("");
  return `<section class="compare">
    <h3>Other ways to go</h3>
    <ul class="options">${current}${rest}</ul>
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

// The leg-by-leg list shared by the main itinerary and an expanded compare-table option.
function stepsList(journey: TflJourney, live: boolean, warnLegs: boolean): string {
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
      return `<li style="--c:${style.colour}"${leg.mode.id === "walking" ? ` class="walking"` : ""}>
        <div class="step-head">${legPill(leg)} <span class="step-from">${esc(cleanName(leg.departurePoint.commonName))}</span> ${crowdSlot(leg.departurePoint.naptanId)}</div>
        <div class="step-body">${esc(instruction)}${warnLegs && leg.isDisrupted ? ` <span class="warn">Disrupted</span>` : ""}</div>
        <div class="step-facts">${facts.map(esc).join(" · ")}</div>
        ${stopList(leg)}
      </li>`;
    })
    .join("");
  const last = journey.legs.at(-1)?.arrivalPoint;
  return `<ol class="steps">${steps}
      <li class="end"><div class="step-head"><span class="step-from">${esc(cleanName(last?.commonName ?? ""))}</span> ${crowdSlot(last?.naptanId)}</div></li>
    </ol>`;
}

// TfL flags legs isDisrupted for minor notices too; showing that under a "Good service"
// verdict contradicts the card, so leg warnings only appear when the verdict agrees.
function itinerary(journey: TflJourney, label: string, live: boolean, warnLegs: boolean): string {
  const arrive = live && journey.arrivalDateTime ? ` · arrive ${londonTime(journey.arrivalDateTime)}` : "";
  return `<section class="itinerary">
    <h3>${esc(label)} <small>${journey.duration} min${arrive}</small></h3>
    ${stepsList(journey, live, warnLegs)}
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
      <div class="board"><div class="board-row empty"><span class="dest">Loading departures…</span></div></div>
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
  // Set when the TfL Arrivals call itself failed, vs. succeeding with zero results —
  // those read very differently to a commuter ("data's down" vs "nothing due yet").
  fetchFailed?: boolean;
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
    ${
      rows ||
      `<div class="board-row empty${b.fetchFailed ? " error" : ""}"><span class="dest">${
        b.fetchFailed ? "Departure data unavailable right now — retrying…" : "No departures due right now"
      }</span></div>`
    }
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
