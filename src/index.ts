import { Hono } from "hono";
import { runVerdict } from "./agent.ts";
import { loadConfig } from "./config.ts";
import { usageSummary } from "./usage.ts";
import { page, usageFooter, verdictCard } from "./views.ts";

const config = loadConfig();

const app = new Hono();

app.get("/", (c) => c.html(page()));

app.post("/plan", async (c) => {
  const form = await c.req.parseBody();
  const from = String(form.from ?? "").trim().slice(0, 100);
  const to = String(form.to ?? "").trim().slice(0, 100);
  if (!from || !to) return c.html(`<p>Enter both a from and a to station.</p>`, 400);

  const run = await runVerdict(from, to, config);
  // Lets the usage footer refresh as soon as a verdict lands instead of on the next poll.
  c.header("HX-Trigger", "verdict");
  return c.html(verdictCard(from, to, run));
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
