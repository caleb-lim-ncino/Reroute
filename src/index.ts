import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { prewarm, runVerdict, type StationInput, type VerdictRun } from "./agent.ts";
import { loadConfig } from "./config.ts";
import {
  activate,
  activeDemo,
  clearDemo,
  DISRUPTION_KINDS,
  lineName,
  lineStops,
  overrideJourneyDisruption,
  overrideLineStatus,
  presetById,
  randomPreset,
  type ActiveDemo,
  type DemoSpec,
  type DemoStop,
  type DisruptionKind,
} from "./demo.ts";
import { LINE_STYLES } from "./lines.ts";
import { cancel, finish, progressOf, STAGES } from "./progress.ts";
import { startStationIndex, stationById, stations } from "./stations.ts";
import {
  getArrivals,
  getJourneyPlan,
  getLineStatus,
  getLiveCrowding,
  getNearestBikePoints,
  getRouteComparison,
  withCycleFare,
} from "./tfl.ts";
import type { TflJourney } from "./tfl-types.ts";
import { usageSummary } from "./usage.ts";
import {
  crowdingChip,
  demoBadge,
  demoMenuItem,
  demoPanel,
  departureBoard,
  page,
  usageFooter,
  verdictCard,
  type CardExtras,
} from "./views.ts";

const config = loadConfig();
startStationIndex(config.tflAppKey);
prewarm(config);

const app = new Hono();

// Unversioned URLs, so make browsers revalidate: a heuristically cached app.css from before
// a markup change leaves new elements unstyled.
app.use("/static/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-cache");
});
app.use("/static/*", serveStatic({ root: "./" }));

app.get("/", (c) => c.html(page(activeDemo())));

// Dev-only panel (tucked in the profile popup) for driving a live demo when there's no real
// TfL disruption to show. hx-swap-oob on the badge markup keeps the header in sync with
// whichever preset the panel just switched to.
const demoResponse = (result: ActiveDemo | string | null) =>
  typeof result === "string"
    ? demoPanel(activeDemo(), result)
    : demoPanel(activeDemo()) + demoBadge(activeDemo()) + demoMenuItem(activeDemo());

app.post("/demo/random", async (c) => c.html(demoResponse(await activate(randomPreset(), config.tflAppKey))));
app.post("/demo/clear", (c) => {
  clearDemo();
  return c.html(demoResponse(null));
});
app.get("/demo/lines/:id/stops", async (c) => {
  const lineId = c.req.param("id");
  if (!lineName(lineId)) return c.json({ error: "unknown line" }, 404);
  try {
    return c.json(await lineStops(lineId, config.tflAppKey));
  } catch (err) {
    console.error(`[demo] couldn't load stops for ${lineId}: ${err}`);
    return c.json({ error: "TfL unavailable" }, 502);
  }
});
app.post("/demo/custom", async (c) => {
  const body = await c.req.parseBody();
  const lineId = field(body.lineId);
  const kind = field(body.kind);
  if (!lineName(lineId) || !Object.hasOwn(DISRUPTION_KINDS, kind)) {
    return c.html(demoResponse("Pick a line and a disruption type."));
  }
  // Station names go into the agent's prompt, so take them from TfL's list, never the form.
  let stops: DemoStop[] = [];
  const fromId = field(body.fromId);
  const toId = field(body.toId);
  if (fromId || toId) {
    try {
      stops = await lineStops(lineId, config.tflAppKey);
    } catch {
      return c.html(demoResponse("Couldn't load that line's stations from TfL. Try again in a moment."));
    }
  }
  const from = stops.find((s) => s.id === fromId);
  const to = stops.find((s) => s.id === toId);
  if ((fromId && !from) || (toId && !to)) return c.html(demoResponse("That station isn't on the chosen line."));
  const spec: DemoSpec = { id: "custom", lineId, kind: kind as DisruptionKind, from, to };
  return c.html(demoResponse(await activate(spec, config.tflAppKey)));
});
app.post("/demo/:id", async (c) => {
  const preset = presetById(c.req.param("id"));
  return c.html(demoResponse(preset ? await activate(preset, config.tflAppKey) : "Unknown preset."));
});

const field = (v: unknown, max = 100) => String(v ?? "").trim().slice(0, max);

// Only trust an id the index knows: it's interpolated into the prompt, and a known id is
// guaranteed plannable.
function stationInput(name: string, id: string): StationInput {
  return stationById(id) ? { name, id } : { name };
}

// Line sequence, e.g. "jubilee>northern>bus:432", for matching the next-week baseline to
// today's live option with the same shape (which carries real departure times).
const signature = (j: TflJourney) =>
  j.legs
    .filter((l) => l.mode.id !== "walking")
    .map((l) => l.routeOptions?.[0]?.lineIdentifier?.id ?? `${l.mode.id}:${l.routeOptions?.[0]?.name ?? ""}`)
    .join(">");

async function routeFor(run: VerdictRun): Promise<CardExtras["route"]> {
  if (!run.journey || run.failure) return undefined;
  try {
    const plan = await getJourneyPlan(run.journey.fromId, run.journey.toId, config.tflAppKey);
    const pick = run.verdict.recommended_live_option;
    if (pick !== null && plan.live[pick]) {
      // TfL's own durations, so "minutes lost" is measured rather than the model's guess.
      return {
        journey: overrideJourneyDisruption(withCycleFare(plan.live[pick]!)),
        label: "Take this route instead",
        live: true,
        usualMinutes: plan.usual?.duration,
      };
    }
    if (plan.usual) {
      const today = plan.live.find((j) => signature(j) === signature(plan.usual!));
      return { journey: overrideJourneyDisruption(withCycleFare(today ?? plan.usual)), label: "Your route", live: !!today };
    }
    return { journey: overrideJourneyDisruption(withCycleFare(plan.live[0]!)), label: "Your route", live: true };
  } catch (err) {
    console.error(`[route] couldn't load itinerary: ${err}`);
    return undefined;
  }
}

async function compareFor(run: VerdictRun, route: CardExtras["route"]): Promise<CardExtras["compare"]> {
  if (!run.journey || run.failure) return undefined;
  try {
    const { options } = await getRouteComparison(run.journey.fromId, run.journey.toId, config.tflAppKey);
    // A mode-restricted alternative that's identical to the route already shown (e.g.
    // "Your route" is already tube-only) is redundant, not a genuine alternative — drop it.
    const routeSig = route ? signature(route.journey) : undefined;
    return options
      .filter((o) => signature(o.journey) !== routeSig)
      .map((o) => ({ ...o, journey: overrideJourneyDisruption(o.journey) }));
  } catch (err) {
    console.error(`[compare] couldn't load alternatives: ${err}`);
    return undefined;
  }
}

// A "cycle" leg rides door-to-door, so its endpoints are just wherever the road route starts
// and ends — never a real docking station. Collect those coordinates, across the recommended
// route and its alternatives, to look up the nearest actual Santander dock to each.
function cyclePoints(journeys: (TflJourney | undefined)[]): Array<{ lat: number; lon: number }> {
  return journeys
    .flatMap((j) => j?.legs ?? [])
    .filter((l) => l.mode.id === "cycle")
    .flatMap((l) => [l.departurePoint, l.arrivalPoint])
    .filter((p) => typeof p.lat === "number" && typeof p.lon === "number")
    .map((p) => ({ lat: p.lat!, lon: p.lon! }));
}

async function cycleAvailabilityFor(
  route: CardExtras["route"],
  compare: CardExtras["compare"],
): Promise<CardExtras["cycleAvailability"]> {
  const points = cyclePoints([route?.journey, ...(compare ?? []).map((o) => o.journey)]);
  if (points.length === 0) return undefined;
  try {
    return await getNearestBikePoints(points, config.tflAppKey);
  } catch (err) {
    console.error(`[cycle] couldn't load dock availability: ${err}`);
    return undefined;
  }
}

app.post("/plan", async (c) => {
  const form = await c.req.parseBody();
  const from = field(form.from);
  const to = field(form.to);
  const rid = field(form.rid, 64);
  if (!from || !to) return c.html(`<p>Enter both a from and a to station.</p>`, 400);

  try {
    const run = await runVerdict(stationInput(from, field(form.fromId, 20)), stationInput(to, field(form.toId, 20)), config, {
      rid: rid || undefined,
    });
    // The commuter cancelled and is no longer waiting on this response; skip the extra
    // TfL calls a card would need and let the client's own abort handle the rest.
    if (run.failure === "cancelled") return c.body(null, 204);
    const route = await routeFor(run);
    const compare = await compareFor(run, route);
    const cycleAvailability = await cycleAvailabilityFor(route, compare);
    // Lets the usage footer refresh as soon as a verdict lands instead of on the next poll.
    c.header("HX-Trigger", "verdict");
    return c.html(verdictCard(from, to, run, { route, compare, cycleAvailability }));
  } finally {
    if (rid) finish(rid);
  }
});

app.get("/progress/:rid", (c) => {
  const p = progressOf(c.req.param("rid"));
  return c.json({ stage: p?.stage ?? 0, stages: STAGES });
});

app.post("/cancel/:rid", (c) => c.json({ cancelled: cancel(c.req.param("rid")) }));

// The whole index, ~30KB: the browser filters it locally so suggestions never wait on the network.
app.get("/stations.json", (c) => {
  const list = stations();
  if (list.length === 0) return c.json({ error: "station index still loading" }, 503);
  c.header("Cache-Control", "public, max-age=3600");
  return c.json({ lines: LINE_STYLES, stations: list });
});

app.get("/crowding/:id", async (c) => {
  try {
    const { value } = await getLiveCrowding(c.req.param("id"), config.tflAppKey);
    return c.html(crowdingChip(value));
  } catch {
    // Crowding is garnish: a failure renders nothing rather than an error on the card.
    return c.html("");
  }
});

app.get("/board/:stopId", async (c) => {
  const stopId = c.req.param("stopId");
  const lineId = field(c.req.query("line"), 40);
  const mode = field(c.req.query("mode"), 20);
  const towards = field(c.req.query("towards"));
  const stationName = field(c.req.query("name")) || stationById(stopId)?.name || "Departures";
  try {
    const [arrivals, status] = await Promise.all([
      getArrivals(stopId, lineId, config.tflAppKey),
      lineId ? getLineStatus([lineId], config.tflAppKey).catch(() => undefined) : undefined,
    ]);
    // Keeps the ticker consistent with the verdict text above it: without this, a demo
    // disruption would say "Severe Delays" while the live board still reads "Good Service".
    const overridden = status ? overrideLineStatus(status) : status;
    return c.html(departureBoard({ stationName, lineId, mode, towards, arrivals: arrivals.value, status: overridden?.lines[0] }));
  } catch (err) {
    console.error(`[board] ${stopId}: ${err}`);
    return c.html(departureBoard({ stationName, lineId, mode, towards, arrivals: [], fetchFailed: true }));
  }
});

app.get("/usage", (c) => c.html(usageFooter(usageSummary())));

// Config sanity check with no secret values — presence/shape only.
app.get("/healthz", (c) =>
  c.json({
    ok: true,
    tflAppKeyConfigured: config.tflAppKey.length > 0,
    awsAuth: config.aws.kind,
    awsRegion: config.aws.region,
    verdictModelIdConfigured: config.verdictModelId.length > 0,
    stationsIndexed: stations().length,
    rates: {
      inputPerMtok: config.rateInputPerMtok,
      outputPerMtok: config.rateOutputPerMtok,
    },
  }),
);

console.log(`Reroute listening on :${config.port}`);

// Bun's runtime auto-serves a default export shaped like { port, fetch }. The agent run
// takes ~15-20s, well past Bun's 10s default idle timeout.
export default { port: config.port, fetch: app.fetch, idleTimeout: 120 };
