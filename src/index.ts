import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { prewarm, runVerdict, type StationInput, type VerdictRun } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { LINE_STYLES } from "./lines.ts";
import { finish, progressOf, STAGES } from "./progress.ts";
import { startStationIndex, stationById, stations } from "./stations.ts";
import { getArrivals, getJourneyPlan, getLineStatus, getLiveCrowding, getRouteComparison } from "./tfl.ts";
import type { TflJourney } from "./tfl-types.ts";
import { usageSummary } from "./usage.ts";
import { crowdingChip, departureBoard, page, usageFooter, verdictCard, type CardExtras } from "./views.ts";

const config = loadConfig();
startStationIndex(config.tflAppKey);
prewarm(config);

const app = new Hono();

app.use("/static/*", serveStatic({ root: "./" }));

app.get("/", (c) => c.html(page()));

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
      return { journey: plan.live[pick]!, label: "Take this route instead", live: true, usualMinutes: plan.usual?.duration };
    }
    if (plan.usual) {
      const today = plan.live.find((j) => signature(j) === signature(plan.usual!));
      return { journey: today ?? plan.usual, label: "Your route", live: !!today };
    }
    return { journey: plan.live[0]!, label: "Your route", live: true };
  } catch (err) {
    console.error(`[route] couldn't load itinerary: ${err}`);
    return undefined;
  }
}

async function compareFor(run: VerdictRun): Promise<CardExtras["compare"]> {
  if (!run.journey || run.failure) return undefined;
  try {
    const { options } = await getRouteComparison(run.journey.fromId, run.journey.toId, config.tflAppKey);
    return options;
  } catch (err) {
    console.error(`[compare] couldn't load alternatives: ${err}`);
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
    const [route, compare] = await Promise.all([routeFor(run), compareFor(run)]);
    // Lets the usage footer refresh as soon as a verdict lands instead of on the next poll.
    c.header("HX-Trigger", "verdict");
    return c.html(verdictCard(from, to, run, { route, compare }));
  } finally {
    if (rid) finish(rid);
  }
});

app.get("/progress/:rid", (c) => {
  const p = progressOf(c.req.param("rid"));
  return c.json({ stage: p?.stage ?? 0, stages: STAGES });
});

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
    return c.html(departureBoard({ stationName, lineId, mode, towards, arrivals: arrivals.value, status: status?.lines[0] }));
  } catch (err) {
    console.error(`[board] ${stopId}: ${err}`);
    return c.html(departureBoard({ stationName, lineId, mode, towards, arrivals: [] }));
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
