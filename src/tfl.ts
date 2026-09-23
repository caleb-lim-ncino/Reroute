import { liveCache, tflCache, type Cached, type TtlCache } from "./cache.ts";
import type {
  DisruptionProjection,
  JourneyLegProjection,
  JourneyOptionProjection,
  JourneyOptionsResult,
  LineDisruptionResult,
  LineStatusResult,
  ResolveStationResult,
  StationMatch,
  TflDisruption,
  TflArrival,
  TflJourney,
  TflJourneyResultsResponse,
  TflLine,
  TflLiveCrowding,
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
      return {
        mode: leg.mode.id,
        lineId: primaryRoute?.id ?? null,
        lineName: primaryRoute?.name ?? null,
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
    fetchTfl<TflJourneyResultsResponse>(path, { mode: JOURNEY_MODES }, appKey),
    // A failed baseline shouldn't sink the live answer; `usual: null` says so downstream.
    fetchTfl<TflJourneyResultsResponse>(path, { mode: JOURNEY_MODES, ...sameTimeNextWeek() }, appKey).catch(
      () => undefined,
    ),
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
    })),
  }));

  return { lines, fetchedAt };
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
      byDescription.set(d.description, { category: d.category, type: d.type, description: d.description });
    }
  }

  return { disruptions: [...byDescription.values()], fetchedAt };
}

// ---- page-only data: departure boards and crowding ------------------------------------

export async function getArrivals(stopId: string, appKey = ""): Promise<Cached<TflArrival[]>> {
  return fetchTfl<TflArrival[]>(`/StopPoint/${encodeURIComponent(stopId)}/Arrivals`, {}, appKey, liveCache);
}

// Live crowding exists only for Underground stations (940G…); anything else reports
// dataAvailable: false, so callers don't need to special-case it.
export async function getLiveCrowding(stopId: string, appKey = ""): Promise<Cached<TflLiveCrowding>> {
  return fetchTfl<TflLiveCrowding>(`/crowding/${encodeURIComponent(stopId)}/Live`, {}, appKey, liveCache);
}
