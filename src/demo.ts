import { LINE_STYLES } from "./lines.ts";
import type { LineDisruptionResult, LineStatusProjection, LineStatusResult, TflJourney } from "./tfl-types.ts";

// Demo mode injects a fake disruption into what get_line_status / get_line_disruption_detail
// hand the agent, so a live demo has something to react to on a quiet TfL day. Everything else
// (journey planning, departure boards, crowding) stays real — only the disrupted line's status
// is synthetic, so the model's reasoning about it is still genuine.
export interface DemoPreset {
  id: string;
  lineId: string;
  lineName: string;
  statusSeverity: number;
  statusSeverityDescription: string;
  reason: string;
  category: string;
  type: string;
  // Present only for closures built from the station-to-station picker, so the journey
  // override (below) can flag just the affected segment instead of the whole line.
  closure?: { fromId: string; fromName: string; toId: string; toName: string };
}

export const DEMO_PRESETS: DemoPreset[] = [
  {
    id: "central-severe",
    lineId: "central",
    lineName: "Central",
    statusSeverity: 6,
    statusSeverityDescription: "Severe Delays",
    reason:
      "Central Line: SEVERE DELAYS. This is currently affecting the whole line in both directions while we deal with a signal failure.",
    category: "RealTime",
    type: "lineInfo",
  },
  {
    id: "victoria-part-closure",
    lineId: "victoria",
    lineName: "Victoria",
    statusSeverity: 5,
    statusSeverityDescription: "Part Closure",
    reason:
      "Victoria Line: PART CLOSURE between Seven Sisters and Walthamstow Central while we carry out planned engineering works. Replacement buses operate.",
    category: "PlannedWork",
    type: "lineInfo",
  },
  {
    id: "northern-minor",
    lineId: "northern",
    lineName: "Northern",
    statusSeverity: 9,
    statusSeverityDescription: "Minor Delays",
    reason: "Northern Line: MINOR DELAYS due to an earlier signal failure at Camden Town.",
    category: "RealTime",
    type: "lineInfo",
  },
  {
    id: "jubilee-severe",
    lineId: "jubilee",
    lineName: "Jubilee",
    statusSeverity: 6,
    statusSeverityDescription: "Severe Delays",
    reason:
      "Jubilee Line: SEVERE DELAYS. This is currently affecting the whole line in both directions due to a person being taken ill on a train.",
    category: "RealTime",
    type: "lineInfo",
  },
  {
    id: "dlr-suspended",
    lineId: "dlr",
    lineName: "DLR",
    statusSeverity: 4,
    statusSeverityDescription: "Suspended",
    reason: "DLR: SUSPENDED. All DLR services are suspended while emergency engineering work takes place.",
    category: "RealTime",
    type: "lineInfo",
  },
  {
    id: "elizabeth-part-closure",
    lineId: "elizabeth",
    lineName: "Elizabeth line",
    statusSeverity: 5,
    statusSeverityDescription: "Part Closure",
    reason: "Elizabeth line: PART CLOSURE between Paddington and Abbey Wood while we investigate a points failure.",
    category: "PlannedWork",
    type: "lineInfo",
  },
];

// Single process, single demo: fine for a presenter driving one screen, same as usage.ts's ledger.
let active: DemoPreset | null = null;

export function activeDemo(): DemoPreset | null {
  return active;
}

export function setDemo(id: string): DemoPreset | undefined {
  const preset = DEMO_PRESETS.find((p) => p.id === id);
  if (preset) active = preset;
  return preset;
}

export function randomDemo(): DemoPreset {
  const pool = DEMO_PRESETS.filter((p) => p.id !== active?.id);
  active = (pool.length ? pool : DEMO_PRESETS)[Math.floor(Math.random() * (pool.length || DEMO_PRESETS.length))]!;
  return active;
}

export function clearDemo(): void {
  active = null;
}

// Builds a one-off preset for a closure between two specific stations, so a presenter can
// demo exactly the segment they need instead of picking the nearest canned preset.
export function setStationClosure(
  lineId: string,
  fromId: string,
  fromName: string,
  toId: string,
  toName: string,
): DemoPreset | undefined {
  const lineName = LINE_STYLES[lineId]?.name;
  if (!lineName || !fromId || !toId || fromId === toId) return undefined;
  active = {
    id: "custom-closure",
    lineId,
    lineName,
    statusSeverity: 5,
    statusSeverityDescription: "Part Closure",
    reason: `${lineName} line: PART CLOSURE between ${fromName} and ${toName} while we carry out engineering works. Replacement buses operate.`,
    category: "PlannedWork",
    type: "lineInfo",
    closure: { fromId, fromName, toId, toName },
  };
  return active;
}

function fakeStatusLine(preset: DemoPreset): LineStatusProjection {
  return {
    lineId: preset.lineId,
    lineName: preset.lineName,
    statuses: [
      {
        statusSeverity: preset.statusSeverity,
        statusSeverityDescription: preset.statusSeverityDescription,
        reason: preset.reason,
        reportedAt: new Date().toISOString(),
        expectedEnd: null,
      },
    ],
  };
}

// Splices the active demo preset into a real get_line_status answer, replacing that line's
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

// The agent's tool calls are faked via the two overrides above, but the page also fetches
// the journey and departure board directly from real TfL data — without this, the itinerary
// and departure ticker would silently contradict the verdict text (Good Service where the
// verdict just said Severe Delays). Flags legs on the demo's line as disrupted so the same
// "Disrupted" tag real disruptions get shows up here too.
export function overrideJourneyDisruption(journey: TflJourney): TflJourney {
  if (!active) return journey;
  const { lineId, closure } = active;
  return {
    ...journey,
    legs: journey.legs.map((leg) => {
      if (!leg.routeOptions?.some((r) => r.lineIdentifier?.id === lineId)) return leg;
      if (!closure) return { ...leg, isDisrupted: true };
      // Only flag legs that actually ride through the closed segment, not every leg on the line.
      const stopIds = new Set(
        [leg.departurePoint.naptanId, leg.arrivalPoint.naptanId, ...(leg.path?.stopPoints?.map((s) => s.id) ?? [])].filter(
          (id): id is string => !!id,
        ),
      );
      return stopIds.has(closure.fromId) && stopIds.has(closure.toId) ? { ...leg, isDisrupted: true } : leg;
    }),
  };
}

export function overrideDisruptionDetail(lineId: string, result: LineDisruptionResult): LineDisruptionResult {
  if (!active || active.lineId !== lineId) return result;
  return {
    disruptions: [
      {
        category: active.category,
        type: active.type,
        description: active.reason,
        // Demo presets simulate an incident already in progress with no known end, same as
        // most real "signal failure" / "person taken ill" disruptions.
        reportedAt: new Date().toISOString(),
        expectedEnd: null,
      },
    ],
    fetchedAt: new Date().toISOString(),
  };
}
