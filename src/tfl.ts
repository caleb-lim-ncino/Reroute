import { liveCache, tflCache, type Cached, type TtlCache } from "./cache.ts";
import type {
  BikePointAvailability,
  DisruptionProjection,
  JourneyLegProjection,
  JourneyOptionProjection,
  JourneyOptionsResult,
  LineDisruptionResult,
  LineStatusResult,
  ResolveStationResult,
  RouteComparisonOption,
  RouteComparisonResult,
  StationMatch,
  TflBikePoint,
  TflDisruption,
  TflArrival,
  TflJourney,
  TflJourneyResultsResponse,
  TflLine,
  TflLiveCrowding,
  TflRouteSequence,
  TflStopPoint,
  TflStopPointMatch,
  TflStopPointSearchResponse,
} from "./tfl-types.ts";

const BASE_URL = "https://api.tfl.gov.uk";
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Thrown by every function in this module on non-2xx or network failure. Carries enough
 * detail for a caller (eventually the MCP tool layer) to tell "TfL said no" apart from
 * "TfL is down" instead of surfacing a bare exception.
 */
export class TflApiError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "network" | "timeout",
  ) {
    super(message);
    this.name = "TflApiError";
  }
}

function appendAppKey(url: URL, appKey: string): void {
  if (appKey) url.searchParams.set("app_key", appKey);
}

/**
 * Cached, timeout-guarded fetch. Every TfL call in this module funnels through here, so
 * caching and the 8s abort apply uniformly across all four functions.
 */
async function fetchTfl<T>(
  path: string,
  params: Record<string, string> = {},
  appKey = "",
  cache: TtlCache = tflCache,
): Promise<Cached<T>> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  appendAppKey(url, appKey);

  const cacheKey = url.toString();
  const cached = cache.get<T>(cacheKey);
  if (cached !== undefined) return cached;

  let response: Response;
  try {
    response = await fetch(cacheKey, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new TflApiError(`TfL request timed out after ${FETCH_TIMEOUT_MS}ms: ${path}`, "timeout");
    }
    throw new TflApiError(`TfL request failed (network error): ${path} — ${String(err)}`, "network");
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new TflApiError(
      `TfL returned ${response.status} ${response.statusText} for ${path}${body ? `: ${body.slice(0, 300)}` : ""}`,
      "http",
    );
  }

  const data = (await response.json()) as T;
  return cache.set(cacheKey, data);
}

function oldest(...timestamps: string[]): string {
  return timestamps.reduce((a, b) => (a < b ? a : b));
}

// ---- 1. resolve_station -------------------------------------------------------------

// In preference order: when a hub has several rail children, the tube one wins.
const RAIL_MODES = ["tube", "overground", "elizabeth-line", "dlr"];

const railRank = (modes: string[]) => {
  const ranks = modes.map((m) => RAIL_MODES.indexOf(m)).filter((i) => i >= 0);
  return ranks.length ? Math.min(...ranks) : Infinity;
};

// Search returns multi-mode interchange hubs (e.g. HUBCAW) as a single match, but the
// Journey Planner answers a hub id with a 300 disambiguation instead of a route. Expand a
// hub to its best rail child so every id we hand out is directly plannable.
async function toRailStop(
  match: TflStopPointMatch,
  searchFetchedAt: string,
  appKey: string,
): Promise<Cached<StationMatch | null>> {
  if (!match.id.startsWith("HUB")) {
    return { value: { id: match.id, name: match.name }, fetchedAt: searchFetchedAt };
  }
  const hub = await fetchTfl<TflStopPoint>(`/StopPoint/${encodeURIComponent(match.id)}`, {}, appKey);
  const child = hub.value.children
    .filter((c) => railRank(c.modes) < Infinity)
    .sort((a, b) => railRank(a.modes) - railRank(b.modes))[0];
  return {
    value: child ? { id: child.naptanId, name: child.commonName } : null,
    fetchedAt: hub.fetchedAt,
  };
}

export async function resolveStation(query: string, appKey = ""): Promise<ResolveStationResult> {
  const search = await fetchTfl<TflStopPointSearchResponse>(
    `/StopPoint/Search/${encodeURIComponent(query)}`,
    { modes: RAIL_MODES.join(",") },
    appKey,
  );

  const candidates = search.value.matches.filter((m) => railRank(m.modes) < Infinity).slice(0, 3);
  const expanded = await Promise.all(candidates.map((m) => toRailStop(m, search.fetchedAt, appKey)));
  const matches = expanded.map((e) => e.value).filter((m): m is StationMatch => m !== null);

  return { matches, fetchedAt: oldest(search.fetchedAt, ...expanded.map((e) => e.fetchedAt)) };
}

// ---- 2. get_journey_options ----------------------------------------------------------

// "cycle" isn't requested here: empirically, JourneyResults only ever returns a cycling leg
// when "cycle" is the *sole* mode in the request — paired with anything else (even just
// "walking") it's silently dropped from every candidate journey, regardless of distance or
// whether cycling would clearly win. So TfL's planner can't blend a cycle leg into a mixed
// itinerary; the cycle-only comparison below queries "cycle" alone to get a real answer.
const JOURNEY_MODES = "tube,bus,walking,overground,dlr,elizabeth-line";

// The Journey Planner is disruption-aware: asked "now", it quietly routes around a
// suspended line, so its fastest answer is a detour rather than the commuter's usual
// route. Asking for the same London wall-clock time one week ahead gives the normal-day
// route to compare against.
function sameTimeNextWeek(now = new Date()): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000))
      .map((p) => [p.type, p.value]),
  );
  // 15-minute slots keep the URL, and so the cache key, stable across a demo session.
  const minute = String(Math.floor(Number(parts.minute) / 15) * 15).padStart(2, "0");
  return { date: `${parts.year}${parts.month}${parts.day}`, time: `${parts.hour}${minute}` };
}

function projectJourney(journey: TflJourney): JourneyOptionProjection {
  return {
    duration: journey.duration,
    legs: journey.legs.map((leg): JourneyLegProjection => {
      const primaryRoute = leg.routeOptions?.[0]?.lineIdentifier;
      const lineNames = Array.from(
        new Set((leg.routeOptions ?? []).map((r) => r.lineIdentifier?.name).filter((n): n is string => !!n)),
      );
      return {
        mode: leg.mode.id,
        lineId: primaryRoute?.id ?? null,
        lineName: primaryRoute?.name ?? null,
        lineNames,
        departurePoint: leg.departurePoint.commonName,
        arrivalPoint: leg.arrivalPoint.commonName,
        duration: leg.duration,
        instruction: leg.instruction?.detailed ?? null,
        isDisrupted: leg.isDisrupted ?? false,
      };
    }),
  };
}

export interface JourneyPlan {
  usual: TflJourney | null;
  live: TflJourney[];
  fetchedAt: string;
}

// Raw journeys, for the page's itinerary. Same URLs as the model's tool call, so rendering
// the route after a verdict is a cache hit, and the page shows exactly what the model saw.
export async function getJourneyPlan(fromId: string, toId: string, appKey = ""): Promise<JourneyPlan> {
  const path = `/Journey/JourneyResults/${encodeURIComponent(fromId)}/to/${encodeURIComponent(toId)}`;
  const [live, baseline] = await Promise.all([
    fetchTfl<TflJourneyResultsResponse>(path, { mode: JOURNEY_MODES, fares: "true" }, appKey),
    // A failed baseline shouldn't sink the live answer; `usual: null` says so downstream.
    fetchTfl<TflJourneyResultsResponse>(
      path,
      { mode: JOURNEY_MODES, fares: "true", ...sameTimeNextWeek() },
      appKey,
    ).catch(() => undefined),
  ]);

  if (!live.value.journeys || live.value.journeys.length === 0) {
    throw new TflApiError(
      `TfL could not plan a journey from ${fromId} to ${toId} (disambiguation or no route returned). ` +
        "Use a specific StopPoint id, not a hub/interchange id.",
      "http",
    );
  }
  return { usual: baseline?.value.journeys?.[0] ?? null, live: live.value.journeys, fetchedAt: live.fetchedAt };
}

export async function getJourneyOptions(
  fromId: string,
  toId: string,
  appKey = "",
): Promise<JourneyOptionsResult> {
  const plan = await getJourneyPlan(fromId, toId, appKey);
  return {
    usual: plan.usual ? projectJourney(plan.usual) : null,
    live: plan.live.map(projectJourney),
    fetchedAt: plan.fetchedAt,
  };
}

// ---- Santander Cycles: cost estimate ---------------------------------------------------
// TfL's fare API never prices a cycle-hire leg (RouteComparisonOption.fareTotalCost would
// otherwise be null), so this is our own estimate off the published tariff:
// https://tfl.gov.uk/modes/cycling/santander-cycles/how-it-works/prices-and-membership
// Priced against a 24-hour Day Pass: each ride is free for the first hour, then billed at
// the same per-30-min rate as pay-as-you-go.
const CYCLE_DAY_PASS_PENCE = 350; // 24-hour Day Pass, unlimited rides
const CYCLE_DAY_PASS_FREE_MINUTES = 60; // free per ride while on a Day Pass
const CYCLE_PAYG_PENCE_PER_30MIN = 165; // pay-as-you-go rate, and the Day Pass's overage rate
// The journey planner never says whether a cycle-hire leg is a classic bike or an e-bike, so
// the e-bike surcharge is reported as an add-on rather than folded into totalPence.
const CYCLE_EBIKE_SURCHARGE_DAY_PASS_PENCE = 100; // per ride, on top of the Day Pass

export interface CycleHireCost {
  dayPassPence: number;
  usagePence: number;
  totalPence: number;
  ebikeSurchargePence: number;
}

function cycleUsagePence(minutes: number): number {
  const billable = Math.max(0, minutes - CYCLE_DAY_PASS_FREE_MINUTES);
  return Math.ceil(billable / 30) * CYCLE_PAYG_PENCE_PER_30MIN;
}

// One Day Pass covers every hire in the journey, but each cycle-hire leg is its own
// 60-minutes-free ride — docking and undocking again resets the clock.
export function estimateCycleHireCost(journey: TflJourney): CycleHireCost | null {
  const legs = journey.legs.filter((l) => l.mode.id === "cycle");
  if (legs.length === 0) return null;
  const usagePence = legs.reduce((sum, l) => sum + cycleUsagePence(l.duration), 0);
  return {
    dayPassPence: CYCLE_DAY_PASS_PENCE,
    usagePence,
    totalPence: CYCLE_DAY_PASS_PENCE + usagePence,
    ebikeSurchargePence: legs.length * CYCLE_EBIKE_SURCHARGE_DAY_PASS_PENCE,
  };
}

// Folds the cycle-hire estimate into the journey's fare so every caller reading
// journey.fare (the compare table, the itinerary facts) sees one number, without mutating
// the cached TfL response object.
export function withCycleFare(journey: TflJourney): TflJourney {
  const cycleCost = estimateCycleHireCost(journey);
  if (!cycleCost) return journey;
  return { ...journey, fare: { totalCost: (journey.fare?.totalCost ?? 0) + cycleCost.totalPence } };
}

// ---- page-only: mode-restricted alternatives, to weigh cost/time against the plan ----

// "cycle" must be queried alone — see the note by JOURNEY_MODES above — so there's no
// "tube,cycle" blended row: TfL's planner has no way to actually produce one.
const COMPARISON_MODES: Array<{ key: string; label: string; modes: string }> = [
  { key: "tube", label: "Tube only", modes: "tube,walking" },
  { key: "bus", label: "Bus only", modes: "bus,walking" },
  { key: "cycle", label: "Santander Cycles only", modes: "cycle" },
];

async function comparisonOption(
  fromId: string,
  toId: string,
  mode: { key: string; label: string; modes: string },
  appKey: string,
): Promise<Cached<RouteComparisonOption> | undefined> {
  const path = `/Journey/JourneyResults/${encodeURIComponent(fromId)}/to/${encodeURIComponent(toId)}`;
  try {
    const { value, fetchedAt } = await fetchTfl<TflJourneyResultsResponse>(
      path,
      { mode: mode.modes, fares: "true" },
      appKey,
    );
    const raw = value.journeys?.[0];
    if (!raw) return undefined;
    const journey = withCycleFare(raw);
    return {
      value: {
        key: mode.key,
        label: mode.label,
        duration: journey.duration,
        fareTotalCost: journey.fare?.totalCost ?? null,
        // Kept so the page can expand this option into a full itinerary without a second fetch.
        journey,
      },
      fetchedAt,
    };
  } catch {
    // A mode with no viable route (e.g. bus-only across the river) just drops out of the table.
    return undefined;
  }
}

// Restricts the planner to one mode at a time (bus-only, tube-only, …) so a commuter can
// weigh cost and time against the route the agent already checked.
export async function getRouteComparison(fromId: string, toId: string, appKey = ""): Promise<RouteComparisonResult> {
  const results = await Promise.all(COMPARISON_MODES.map((m) => comparisonOption(fromId, toId, m, appKey)));
  const present = results.filter((r): r is Cached<RouteComparisonOption> => r !== undefined);
  return {
    options: present.map((r) => r.value),
    fetchedAt: present.length ? oldest(...present.map((r) => r.fetchedAt)) : new Date().toISOString(),
  };
}

// ---- 3. get_line_status ---------------------------------------------------------------

export async function getLineStatus(lineIds: string[], appKey = ""): Promise<LineStatusResult> {
  const { value: data, fetchedAt } = await fetchTfl<TflLine[]>(
    `/Line/${lineIds.map(encodeURIComponent).join(",")}/Status`,
    {},
    appKey,
  );

  const lines = data.map((line) => ({
    lineId: line.id,
    lineName: line.name,
    // A single line can carry multiple simultaneous statuses (e.g. severe delays on one
    // section, minor delays on the rest) — collapsing to one entry would drop information.
    statuses: line.lineStatuses.map((status) => ({
      statusSeverity: status.statusSeverity,
      statusSeverityDescription: status.statusSeverityDescription,
      reason: status.reason ?? null,
      reportedAt: status.created ?? null,
      expectedEnd: status.validityPeriods?.at(-1)?.toDate ?? null,
    })),
  }));

  return { lines, fetchedAt };
}

// Every branch of a line as an ordered list of stop ids, plus each stop's name. Journey legs
// use the same ids in their path, so a slice of one of these routes is a line segment.
export async function getLineRoutes(
  lineId: string,
  appKey = "",
): Promise<{ routes: string[][]; names: Map<string, string> }> {
  const { value } = await fetchTfl<TflRouteSequence>(
    `/Line/${encodeURIComponent(lineId)}/Route/Sequence/all`,
    {},
    appKey,
  );
  const names = new Map<string, string>();
  for (const seq of value.stopPointSequences ?? []) for (const s of seq.stopPoint) names.set(s.id, s.name);
  return { routes: (value.orderedLineRoutes ?? []).map((r) => r.naptanIds), names };
}

// ---- 4. get_line_disruption_detail -----------------------------------------------------

export async function getLineDisruptionDetail(lineId: string, appKey = ""): Promise<LineDisruptionResult> {
  const { value: data, fetchedAt } = await fetchTfl<TflDisruption[]>(
    `/Line/${encodeURIComponent(lineId)}/Disruption`,
    {},
    appKey,
  );

  // TfL publishes the same incident once per scope (routeInfo + lineInfo) with identical
  // text; passing both to the model just doubles the tokens.
  const byDescription = new Map<string, DisruptionProjection>();
  for (const d of data) {
    if (!byDescription.has(d.description)) {
      byDescription.set(d.description, {
        category: d.category,
        type: d.type,
        description: d.description,
        reportedAt: d.created ?? null,
        // TfL only tells us the end when the period isn't open-ended, so take the last
        // period's toDate; anything else (missing, or still isNow with no end) is unknown.
        expectedEnd: d.validityPeriods?.at(-1)?.toDate ?? null,
      });
    }
  }

  return { disruptions: [...byDescription.values()], fetchedAt };
}

// ---- page-only data: departure boards and crowding ------------------------------------

async function arrivalsAt(stopId: string, appKey: string): Promise<Cached<TflArrival[]>> {
  return fetchTfl<TflArrival[]>(`/StopPoint/${encodeURIComponent(stopId)}/Arrivals`, {}, appKey, liveCache);
}

// Leaf stops under a StopPoint tree (e.g. the lettered stands of a bus station) that serve `lineId`.
function leafStops(node: TflStopPoint, lineId: string): string[] {
  if (!node.children?.length) {
    const serves = !lineId || (node.lines ?? []).some((l) => l.id === lineId);
    return serves ? [node.naptanId] : [];
  }
  return node.children.flatMap((c) => leafStops(c, lineId));
}

// Bus legs start at a stop *group* (490G…, e.g. "West Croydon Bus Station"), and TfL
// answers arrivals for a group with an empty list: the buses belong to its lettered stands
// (B1, B3…), two levels down. Expand the group to the stands serving this route.
export async function getArrivals(stopId: string, lineId = "", appKey = ""): Promise<Cached<TflArrival[]>> {
  if (!stopId.startsWith("490G") && !stopId.startsWith("HUB")) return arrivalsAt(stopId, appKey);
  const group = await fetchTfl<TflStopPoint>(`/StopPoint/${encodeURIComponent(stopId)}`, {}, appKey);
  const stands = [...new Set(leafStops(group.value, lineId))].slice(0, 6);
  if (stands.length === 0) return arrivalsAt(stopId, appKey);
  const all = await Promise.all(stands.map((id) => arrivalsAt(id, appKey)));
  return { value: all.flatMap((a) => a.value), fetchedAt: oldest(...all.map((a) => a.fetchedAt)) };
}

// Live crowding exists only for Underground stations (940G…); anything else reports
// dataAvailable: false, so callers don't need to special-case it.
export async function getLiveCrowding(stopId: string, appKey = ""): Promise<Cached<TflLiveCrowding>> {
  return fetchTfl<TflLiveCrowding>(`/crowding/${encodeURIComponent(stopId)}/Live`, {}, appKey, liveCache);
}

function bikePointCounter(bp: TflBikePoint, key: string): number {
  return Number(bp.additionalProperties.find((p) => p.key === key)?.value ?? 0);
}

function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// A "cycle" leg rides door-to-door, not dock-to-dock, so its departure/arrival points are
// never themselves BikePoints — the nearest real docking station is a lookup, not a given.
const MAX_DOCK_DISTANCE_M = 400;

// Stable key for a coordinate, shared with callers so a leg's departurePoint/arrivalPoint
// can be looked up in the map this returns.
export const coordKey = (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

// Live dock/bike counts for the nearest Santander Cycles docking station to each given point,
// so a cycle leg can say "walk to this dock" and flag "no bikes here"/"no docks there" instead
// of assuming a dock is always nearby and always stocked.
export async function getNearestBikePoints(
  points: Array<{ lat: number; lon: number }>,
  appKey = "",
): Promise<Map<string, BikePointAvailability>> {
  const result = new Map<string, BikePointAvailability>();
  if (points.length === 0) return result;
  const { value: all } = await fetchTfl<TflBikePoint[]>("/BikePoint", {}, appKey, liveCache);
  for (const p of points) {
    let best: { bp: TflBikePoint; distanceMeters: number } | undefined;
    for (const bp of all) {
      const distanceMeters = haversineMeters(p, bp);
      if (distanceMeters <= MAX_DOCK_DISTANCE_M && (!best || distanceMeters < best.distanceMeters)) {
        best = { bp, distanceMeters };
      }
    }
    if (best) {
      result.set(coordKey(p), {
        id: best.bp.id,
        name: best.bp.commonName,
        bikes: bikePointCounter(best.bp, "NbBikes"),
        emptyDocks: bikePointCounter(best.bp, "NbEmptyDocks"),
        distanceMeters: Math.round(best.distanceMeters),
      });
    }
  }
  return result;
}
