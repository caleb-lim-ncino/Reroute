import type { TflLineStopPoint } from "./tfl-types.ts";
import { LINE_STYLES } from "./lines.ts";

// The station list behind the autocomplete. Built once at boot from /Line/{id}/StopPoints
// (the all-modes /StopPoint/Mode endpoint routinely times out) and shipped whole to the
// browser, which filters it locally — so suggestions appear on every keystroke with no
// network round-trip.

export interface Station {
  // A plannable, non-hub StopPoint id (tube child preferred), safe for the Journey Planner.
  id: string;
  name: string;
  lines: string[];
}

const RAIL_LINE_IDS = Object.keys(LINE_STYLES);
const MODE_PREFERENCE = ["tube", "overground", "elizabeth-line", "dlr"];
const REFRESH_MS = 12 * 60 * 60 * 1000;

let index: Station[] = [];
let byId = new Map<string, Station>();

export function cleanName(name: string): string {
  return name
    .replace(/\s*\((?:[^)]*line|H&C Line)\)/gi, "")
    .replace(/-Underground$/i, "")
    .replace(/\s+(?:Underground|DLR|ELL Rail|Rail|Elizabeth line)\s+Station$/i, "")
    .replace(/\s+Station$/i, "")
    .trim();
}

const modeRank = (modes: string[]) =>
  Math.min(...modes.map((m) => MODE_PREFERENCE.indexOf(m)).filter((i) => i >= 0), MODE_PREFERENCE.length);

async function fetchLineStops(lineId: string, appKey: string): Promise<TflLineStopPoint[]> {
  const url = `https://api.tfl.gov.uk/Line/${lineId}/StopPoints?app_key=${encodeURIComponent(appKey)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`StopPoints for ${lineId}: HTTP ${res.status}`);
  return (await res.json()) as TflLineStopPoint[];
}

async function build(appKey: string): Promise<void> {
  const started = Date.now();
  const results = await Promise.allSettled(RAIL_LINE_IDS.map((id) => fetchLineStops(id, appKey)));

  // Merge per interchange hub, so "Canary Wharf" is one suggestion carrying Jubilee, DLR
  // and Elizabeth rather than three near-duplicates.
  const groups = new Map<string, { stops: TflLineStopPoint[]; lines: Set<string> }>();
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`[stations] ${RAIL_LINE_IDS[i]} failed: ${r.reason}`);
      return;
    }
    for (const stop of r.value) {
      const key = stop.hubNaptanCode ?? stop.naptanId;
      const group = groups.get(key) ?? { stops: [], lines: new Set<string>() };
      group.stops.push(stop);
      for (const l of stop.lines) if (l.id in LINE_STYLES) group.lines.add(l.id);
      groups.set(key, group);
    }
  });

  const next: Station[] = [];
  for (const { stops, lines } of groups.values()) {
    const best = [...stops].sort((a, b) => modeRank(a.modes) - modeRank(b.modes))[0]!;
    const names = [...new Set(stops.map((s) => cleanName(s.commonName)))].sort((a, b) => a.length - b.length);
    next.push({ id: best.naptanId, name: names[0]!, lines: RAIL_LINE_IDS.filter((l) => lines.has(l)) });
  }
  next.sort((a, b) => a.name.localeCompare(b.name));

  if (next.length === 0) throw new Error("no stations loaded");
  index = next;
  byId = new Map(next.map((s) => [s.id, s]));
  console.log(`[stations] indexed ${next.length} stations in ${Date.now() - started}ms`);
}

// Non-blocking: the server starts immediately and the free-text path still works (the
// agent resolves names itself) while the index loads or if TfL is down.
export function startStationIndex(appKey: string): void {
  const load = () => build(appKey).catch((err) => console.error(`[stations] build failed: ${err}`));
  load();
  setInterval(load, REFRESH_MS).unref();
}

export const stations = () => index;
export const stationById = (id: string) => byId.get(id);
