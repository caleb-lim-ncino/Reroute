// Narrow types for the slice of the TfL Unified API responses we actually read.
// These are intentionally partial — TfL's real payloads carry a lot more ($type, uris,
// crowding placeholders, etc.) that we never touch.

// ---- raw TfL response shapes -------------------------------------------------------

export interface TflStopPointMatch {
  id: string;
  name: string;
  modes: string[];
}

export interface TflStopPointSearchResponse {
  matches: TflStopPointMatch[];
}

export interface TflStopPoint {
  naptanId: string;
  commonName: string;
  modes: string[];
  children: TflStopPoint[];
  lines?: Array<{ id: string }>;
}

export interface TflPlace {
  commonName: string;
  naptanId?: string;
  // Set for places with no naptanId, e.g. Santander Cycles docking stations ("BikePoints_123").
  id?: string;
  lat?: number;
  lon?: number;
}

export interface TflLineIdentifier {
  id: string;
  name: string;
}

export interface TflRouteOption {
  name: string;
  lineIdentifier?: TflLineIdentifier;
  directions?: string[];
}

export interface TflPathStopPoint {
  id: string;
  name: string;
}

export interface TflJourneyLeg {
  duration: number;
  mode: { id: string; name: string };
  departurePoint: TflPlace;
  arrivalPoint: TflPlace;
  routeOptions?: TflRouteOption[];
  isDisrupted?: boolean;
  departureTime?: string;
  arrivalTime?: string;
  instruction?: { summary: string; detailed: string };
  // The intermediate stations between departurePoint and arrivalPoint (exclusive of both).
  path?: { stopPoints?: TflPathStopPoint[] };
}

export interface TflJourneyFare {
  totalCost: number;
}

export interface TflJourney {
  duration: number;
  startDateTime?: string;
  arrivalDateTime?: string;
  legs: TflJourneyLeg[];
  fare?: TflJourneyFare;
}

export interface TflJourneyResultsResponse {
  journeys?: TflJourney[];
  // Present instead of `journeys` when TfL couldn't resolve one of the endpoints unambiguously.
  toLocationDisambiguation?: unknown;
  fromLocationDisambiguation?: unknown;
}

export interface TflLineStatus {
  statusSeverity: number;
  statusSeverityDescription: string;
  reason?: string;
  // When TfL first logged this status.
  created?: string;
  // TfL's own windows for how long the status applies; the last one's toDate (if any) is
  // the closest thing TfL gives to "expected to end at".
  validityPeriods?: Array<{ fromDate: string; toDate: string; isNow?: boolean }>;
}

export interface TflLine {
  id: string;
  name: string;
  lineStatuses: TflLineStatus[];
}

// One entry of /Line/{id}/StopPoints. `lines` lists every line at the stop, buses included.
export interface TflLineStopPoint {
  naptanId: string;
  commonName: string;
  modes: string[];
  hubNaptanCode?: string;
  lines: Array<{ id: string }>;
}

export interface TflLiveCrowding {
  dataAvailable: boolean;
  percentageOfBaseline: number;
  timeUtc: string | null;
}

export interface TflArrival {
  lineId: string;
  lineName: string;
  platformName: string;
  destinationName: string;
  towards?: string;
  timeToStation: number;
  currentLocation?: string;
}

export interface TflDisruption {
  category: string;
  type: string;
  description: string;
  // When TfL first logged this incident.
  created?: string;
  // TfL's own windows for how long the disruption applies; the last one's toDate (if any)
  // is the closest thing TfL gives to "expected to end at".
  validityPeriods?: Array<{ fromDate: string; toDate: string; isNow?: boolean }>;
}

// ---- projected shapes we hand to the model -------------------------------------------

export interface StationMatch {
  id: string;
  name: string;
}

export interface ResolveStationResult {
  matches: StationMatch[];
  fetchedAt: string;
}

export interface JourneyLegProjection {
  mode: string;
  lineId: string | null;
  lineName: string | null;
  // All lines sharing this leg's track (e.g. H&C and Circle both run Hammersmith to
  // Liverpool Street) — lineId/lineName above are just the first of these.
  lineNames: string[];
  departurePoint: string;
  arrivalPoint: string;
  duration: number;
  instruction: string | null;
  // TfL's own flag: the planner knows of a disruption affecting this leg right now.
  isDisrupted: boolean;
}

export interface JourneyOptionProjection {
  duration: number;
  legs: JourneyLegProjection[];
}

export interface JourneyOptionsResult {
  // The planner's answer for the same time one week ahead: the route on a normal day.
  usual: JourneyOptionProjection | null;
  // The planner's answer right now. It already routes around known disruptions.
  live: JourneyOptionProjection[];
  fetchedAt: string;
}

export interface LineStatusProjection {
  lineId: string;
  lineName: string;
  statuses: Array<{
    statusSeverity: number;
    statusSeverityDescription: string;
    reason: string | null;
    // ISO timestamp of when TfL first reported this, or null if TfL didn't say.
    reportedAt: string | null;
    // ISO timestamp of when TfL expects this to end, or null if unknown.
    expectedEnd: string | null;
  }>;
}

// /Line/{id}/Route/Sequence/all, trimmed to the fields demo mode reads.
export interface TflRouteSequence {
  stopPointSequences?: Array<{ stopPoint: Array<{ id: string; name: string }> }>;
  orderedLineRoutes?: Array<{ name: string; naptanIds: string[] }>;
}

export interface LineStatusResult {
  lines: LineStatusProjection[];
  fetchedAt: string;
}

export interface DisruptionProjection {
  category: string;
  type: string;
  description: string;
  // ISO timestamp of when TfL first reported this, or null if TfL didn't say.
  reportedAt: string | null;
  // ISO timestamp of when TfL expects this to end, or null if unknown.
  expectedEnd: string | null;
}

export interface LineDisruptionResult {
  disruptions: DisruptionProjection[];
  fetchedAt: string;
}

// ---- page-only: mode-restricted alternatives, for weighing cost/time against the plan --

export interface RouteComparisonOption {
  key: string;
  label: string;
  duration: number;
  // Pay-as-you-go pence, or null when TfL didn't price this mode (e.g. cycling).
  fareTotalCost: number | null;
  // The full journey, so the page can expand this option into a step-by-step itinerary.
  journey: TflJourney;
}

export interface RouteComparisonResult {
  options: RouteComparisonOption[];
  fetchedAt: string;
}

// ---- page-only: Santander Cycles docking-station availability -------------------------

// /BikePoint, trimmed to the fields we read: location, and the counters in `additionalProperties`.
export interface TflBikePoint {
  id: string;
  commonName: string;
  lat: number;
  lon: number;
  additionalProperties: Array<{ key: string; value: string }>;
}

export interface BikePointAvailability {
  id: string;
  name: string;
  bikes: number;
  emptyDocks: number;
  distanceMeters: number;
}
