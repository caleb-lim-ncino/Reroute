import { LINE_STYLES } from "./lines.ts";
import { cleanName } from "./stations.ts";
import { getLineRoutes } from "./tfl.ts";
import type { LineDisruptionResult, LineStatusProjection, LineStatusResult, TflJourney } from "./tfl-types.ts";

// Demo mode injects a fake disruption into what get_line_status / get_line_disruption_detail
// hand the agent, so a live demo has something to react to on a quiet TfL day. Everything else
// (journey planning, departure boards, crowding) stays real — only the disrupted line's status
// is synthetic, so the model's reasoning about it is still genuine.

export type DisruptionKind = "minor" | "severe" | "closure" | "suspended";

interface KindSpec {
  label: string;
  // TfL's own severity codes/descriptions, whole-line vs. between two stations.
  line: [number, string];
  segment: [number, string];
  cause: string;
  category: string;
  // Only closures/suspensions get replacement buses in TfL's wording.
  after?: string;
}

export const DISRUPTION_KINDS: Record<DisruptionKind, KindSpec> = {
  minor: {
    label: "Minor delays",
    line: [9, "Minor Delays"],
    segment: [9, "Minor Delays"],
    cause: "due to an earlier signal failure",
    category: "RealTime",
  },
  severe: {
    label: "Severe delays",
    line: [6, "Severe Delays"],
    segment: [6, "Severe Delays"],
    cause: "while we fix a signal failure",
    category: "RealTime",
  },
  closure: {
    label: "Closure",
    line: [4, "Planned Closure"],
    segment: [5, "Part Closure"],
    cause: "while we carry out planned engineering works",
    category: "PlannedWork",
    after: "Replacement buses operate.",
  },
  suspended: {
    label: "Suspended",
    line: [2, "Suspended"],
    segment: [3, "Part Suspended"],
    cause: "while emergency engineering work takes place",
    category: "RealTime",
    after: "Tickets are being accepted on local buses.",
  },
};

export interface DemoStop {
  id: string;
  name: string;
}

export interface DemoSpec {
  id: string;
  lineId: string;
  kind: DisruptionKind;
  from?: DemoStop;
  to?: DemoStop;
  cause?: string;
}

export interface ActiveDemo {
  id: string;
  lineId: string;
  lineName: string;
  kind: DisruptionKind;
  statusSeverity: number;
  statusSeverityDescription: string;
  reason: string;
  category: string;
  // Set when the disruption covers only part of the line: every stop id from `from` to `to`
  // along the line, so journeys are flagged only when they actually ride through it.
  segment?: { fromName: string; toName: string; stopIds: Set<string> };
}

export const DEMO_PRESETS: DemoSpec[] = [
  { id: "central-severe", lineId: "central", kind: "severe" },
  {
    id: "victoria-part-closure",
    lineId: "victoria",
    kind: "closure",
    from: { id: "940GZZLUSVS", name: "Seven Sisters" },
    to: { id: "940GZZLUWWL", name: "Walthamstow Central" },
  },
  { id: "northern-minor", lineId: "northern", kind: "minor", cause: "due to an earlier signal failure at Camden Town" },
  { id: "jubilee-severe", lineId: "jubilee", kind: "severe", cause: "due to a person being taken ill on a train" },
  { id: "dlr-suspended", lineId: "dlr", kind: "suspended" },
  {
    id: "elizabeth-part-suspended",
    lineId: "elizabeth",
    kind: "suspended",
    from: { id: "910GPADTLL", name: "Paddington" },
    to: { id: "910GABWDXR", name: "Abbey Wood" },
    cause: "while we investigate a points failure",
  },
];

const FULL_NAMES: Record<string, string> = {
  "hammersmith-city": "Hammersmith & City",
  "waterloo-city": "Waterloo & City",
  elizabeth: "Elizabeth line",
};

export function lineName(lineId: string): string | undefined {
  return FULL_NAMES[lineId] ?? LINE_STYLES[lineId]?.name;
}

// "Victoria line", "Elizabeth line", "DLR" — how TfL itself words it in status text.
function spokenLine(lineId: string, name: string): string {
  return lineId === "dlr" || /line$/i.test(name) ? name : `${name} line`;
}

export function kindLabel(kind: DisruptionKind, segment: boolean): string {
  return DISRUPTION_KINDS[kind][segment ? "segment" : "line"][1];
}

// Single process, single demo: fine for a presenter driving one screen, same as usage.ts's ledger.
let active: ActiveDemo | null = null;

export function activeDemo(): ActiveDemo | null {
  return active;
}

export function clearDemo(): void {
  active = null;
}

// Stops on a line in running order, for the From/To pickers. Branches follow the trunk.
export async function lineStops(lineId: string, appKey: string): Promise<DemoStop[]> {
  const { routes, names } = await getLineRoutes(lineId, appKey);
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  const out: DemoStop[] = [];
  for (const route of [...routes].sort((a, b) => b.length - a.length)) {
    for (const id of route) {
      if (seen.has(id)) continue;
      seen.add(id);
      const name = cleanName(names.get(id) ?? id);
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      out.push({ id, name });
    }
  }
  return out;
}

// The shortest run of stops between the two ids on any one branch. Stops sharing a name
// (e.g. Elizabeth line's two Paddington ids) count as the same station.
async function resolveSegment(lineId: string, fromId: string, toId: string, appKey: string): Promise<Set<string> | null> {
  const { routes, names } = await getLineRoutes(lineId, appKey);
  const nameOf = (id: string) => cleanName(names.get(id) ?? id);
  const fromName = nameOf(fromId);
  const toName = nameOf(toId);
  let best: string[] | null = null;
  for (const route of routes) {
    const a = route.findIndex((id) => nameOf(id) === fromName);
    const b = route.findIndex((id) => nameOf(id) === toName);
    if (a < 0 || b < 0) continue;
    const slice = route.slice(Math.min(a, b), Math.max(a, b) + 1);
    if (!best || slice.length < best.length) best = slice;
  }
  if (!best) return null;
  const segNames = new Set(best.map(nameOf));
  return new Set([...names.keys()].filter((id) => segNames.has(nameOf(id))));
}

// Builds and activates a disruption. Returns an error message instead when the request
// can't be simulated (unknown line, stations not on the same branch, TfL unreachable).
export async function activate(spec: DemoSpec, appKey: string): Promise<ActiveDemo | string> {
  const name = lineName(spec.lineId);
  const kind = DISRUPTION_KINDS[spec.kind];
  if (!name || !kind) return "Pick a line and a disruption type.";
  if (!!spec.from !== !!spec.to) return "Pick both a From and a To station, or neither for the whole line.";
  if (spec.from && spec.to && spec.from.id === spec.to.id) return "From and To must be different stations.";

  const line = spokenLine(spec.lineId, name);
  const cause = spec.cause ?? kind.cause;
  let segment: ActiveDemo["segment"];
  let reason: string;
  let severity: [number, string];

  if (spec.from && spec.to) {
    let stopIds: Set<string> | null;
    try {
      stopIds = await resolveSegment(spec.lineId, spec.from.id, spec.to.id, appKey);
    } catch {
      return `Couldn't load the ${line}'s stations from TfL. Try again in a moment.`;
    }
    if (!stopIds) return `${spec.from.name} and ${spec.to.name} aren't on the same branch of the ${line}.`;
    segment = { fromName: spec.from.name, toName: spec.to.name, stopIds };
    severity = kind.segment;
    reason =
      `${line}: ${severity[1].toUpperCase()} between ${spec.from.name} and ${spec.to.name} ${cause}. ` +
      `${kind.after ? `${kind.after} ` : ""}GOOD SERVICE on the rest of the line.`;
  } else {
    severity = kind.line;
    reason = `${line}: ${severity[1].toUpperCase()} across the whole line in both directions ${cause}.${kind.after ? ` ${kind.after}` : ""}`;
  }

  active = {
    id: spec.id,
    lineId: spec.lineId,
    lineName: name,
    kind: spec.kind,
    statusSeverity: severity[0],
    statusSeverityDescription: severity[1],
    reason,
    category: kind.category,
    segment,
  };
  return active;
}

export function presetById(id: string): DemoSpec | undefined {
  return DEMO_PRESETS.find((p) => p.id === id);
}

export function randomPreset(): DemoSpec {
  const pool = DEMO_PRESETS.filter((p) => p.id !== active?.id);
  return pool[Math.floor(Math.random() * pool.length)] ?? DEMO_PRESETS[0]!;
}

function fakeStatusLine(demo: ActiveDemo): LineStatusProjection {
  return {
    lineId: demo.lineId,
    lineName: demo.lineName,
    statuses: [
      {
        statusSeverity: demo.statusSeverity,
        statusSeverityDescription: demo.statusSeverityDescription,
        reason: demo.reason,
        reportedAt: new Date().toISOString(),
        expectedEnd: null,
      },
    ],
  };
}

// Splices the active demo into a real get_line_status answer, replacing that line's
// real entry if it was already in the request, or appending it if the commuter's journey
// legs didn't happen to include it.
export function overrideLineStatus(result: LineStatusResult): LineStatusResult {
  if (!active) return result;
  const idx = result.lines.findIndex((l) => l.lineId === active!.lineId);
  const lines = [...result.lines];
  const fake = fakeStatusLine(active);
  if (idx >= 0) lines[idx] = fake;
  else lines.push(fake);
  return { ...result, lines };
}

// The agent's tool calls are faked via the overrides here, but the page also fetches the
// journey and departure board directly from real TfL data — without this, the itinerary
// would silently contradict the verdict text. Flags legs on the demo's line as disrupted;
// for a segment, only legs that travel at least one hop inside it.
export function overrideJourneyDisruption(journey: TflJourney): TflJourney {
  if (!active) return journey;
  const { lineId, segment } = active;
  return {
    ...journey,
    legs: journey.legs.map((leg) => {
      if (!leg.routeOptions?.some((r) => r.lineIdentifier?.id === lineId)) return leg;
      if (!segment) return { ...leg, isDisrupted: true };
      const stops = [
        leg.departurePoint.naptanId,
        ...(leg.path?.stopPoints?.map((s) => s.id) ?? []),
        leg.arrivalPoint.naptanId,
      ];
      const rides = stops.some(
        (id, i) => i > 0 && !!id && !!stops[i - 1] && segment.stopIds.has(id) && segment.stopIds.has(stops[i - 1]!),
      );
      return rides ? { ...leg, isDisrupted: true } : leg;
    }),
  };
}

export function overrideDisruptionDetail(lineId: string, result: LineDisruptionResult): LineDisruptionResult {
  if (!active || active.lineId !== lineId) return result;
  return {
    disruptions: [
      {
        category: active.category,
        type: "lineInfo",
        description: active.reason,
        // Demo disruptions simulate an incident already in progress with no known end, same
        // as most real "signal failure" / "person taken ill" disruptions.
        reportedAt: new Date().toISOString(),
        expectedEnd: null,
      },
    ],
    fetchedAt: new Date().toISOString(),
  };
}
