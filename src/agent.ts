import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "./config.ts";
import { Verdict, verdictJsonSchema } from "./schema.ts";
import { createTflServer, TFL_SERVER_NAME } from "./tools.ts";
import { recordUsage, usageSummary } from "./usage.ts";

const SYSTEM_PROMPT = `You check whether a London commuter's usual Tube route still holds up right now.

Steps:
1. Resolve both stations with resolve_station. If a name is ambiguous, pick the station a commuter most plausibly means.
2. Plan the journey with get_journey_options. "usual" is the route on a normal day: that is the route you are checking. "live" is what TfL's planner suggests right now, and it already routes around known disruptions. So if the fastest live option differs from usual, or is much slower, or any leg has isDisrupted true, that is evidence the usual route is hit. Note every line the usual route's legs use (if usual is null, fall back to the fastest live option and lower confidence to medium).
3. Call get_line_status once, with all of those lines.
4. If any line is below Good Service, judge whether the commuter would actually notice. Minor Delays on a short leg barely matter; Severe Delays, a part closure, or a suspension on a leg they ride — especially the interchange line — does. Call get_line_disruption_detail when the cause changes the answer: planned engineering is predictable, a signal failure is not.
5. Only when the disruption is noticeable, recommend the fastest live option that avoids the disrupted section, and estimate minutes_lost as its duration minus the usual duration. Never invent a route that isn't one of the live options.

Make independent tool calls in parallel (e.g. both resolve_station calls at once).

Confidence:
- "low" if any tool call errored, a response was missing, or any fetchedAt is more than 3 minutes before the current time you are given. Never trust stale or missing data silently.
- "medium" if the data is fresh but the impact of a disruption on this particular trip is uncertain.
- "high" otherwise.

The verdict is one plain-English sentence a commuter would read on the platform: say what to do, not how you worked it out. minutes_lost is your estimate of extra minutes versus a normal day, 0 if none. alternative_summary is null unless you are recommending the alternative; when you are, name the actual lines or bus routes and where to change, e.g. "Victoria line to Vauxhall, then bus 344".`;

export interface VerdictRun {
  verdict: Verdict;
  model: string;
  durationMs: number;
  costUsd: number;
  // Present when the agent couldn't produce a trustworthy verdict; the verdict is then a safe fallback.
  failure?: string;
}

function fallback(): Verdict {
  return {
    verdict: "Couldn't check live status right now, so treat your usual route as unverified.",
    is_disrupted: false,
    confidence: "low",
    minutes_lost: 0,
    alternative_summary: null,
  };
}

// The SDK's `env` option replaces the subprocess environment rather than merging, so build
// it explicitly. Empty values are dropped: an empty AWS_ACCESS_KEY_ID from .env would
// otherwise shadow the SSO profile in the AWS credential chain.
function subprocessEnv(config: Config): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value) env[key] = value;
  }
  delete env.AWS_PROFILE;
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;

  const aws = config.aws;
  if (aws.kind === "profile") {
    env.AWS_PROFILE = aws.profile;
  } else {
    env.AWS_ACCESS_KEY_ID = aws.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = aws.secretAccessKey;
  }
  env.AWS_REGION = aws.region;
  env.CLAUDE_CODE_USE_BEDROCK = "1";
  // Pin every model slot to the verdict profile. The CLI makes background calls with its
  // "small fast" model, whose default bare Bedrock id is denied by the org SCP.
  env.ANTHROPIC_MODEL = config.verdictModelId;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.verdictModelId;
  env.ANTHROPIC_SMALL_FAST_MODEL = config.verdictModelId;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "reroute/0.1.0";
  return env;
}

export async function runVerdict(from: string, to: string, config: Config): Promise<VerdictRun> {
  const started = Date.now();
  const rates = { inputPerMtok: config.rateInputPerMtok, outputPerMtok: config.rateOutputPerMtok };
  let result: SDKResultMessage | undefined;
  let thrown: unknown;

  try {
    for await (const message of query({
      prompt: `Current time: ${new Date().toISOString()}\nFrom: ${from}\nTo: ${to}`,
      options: {
        model: config.verdictModelId,
        systemPrompt: SYSTEM_PROMPT,
        mcpServers: { [TFL_SERVER_NAME]: createTflServer(config.tflAppKey) },
        allowedTools: [`mcp__${TFL_SERVER_NAME}__*`],
        // No built-in tools, no filesystem settings, no session files: this is a server, and
        // the host's ~/.claude config must not leak into its behaviour.
        tools: [],
        settingSources: [],
        persistSession: false,
        permissionMode: "dontAsk",
        maxTurns: 12,
        outputFormat: { type: "json_schema", schema: verdictJsonSchema },
        env: subprocessEnv(config),
      },
    })) {
      if (message.type === "result") result = message;
    }
  } catch (err) {
    // A single-shot query() throws after yielding an error result; keep the result if we got one.
    thrown = err;
  }

  let costUsd = 0;
  for (const [model, u] of Object.entries(result?.modelUsage ?? {})) {
    costUsd += recordUsage(model, u, rates);
  }
  const durationMs = Date.now() - started;
  const base = { model: config.verdictModelId, durationMs, costUsd };

  let failure: string | undefined;
  if (result?.subtype === "success" && result.structured_output !== undefined) {
    const parsed = Verdict.safeParse(result.structured_output);
    if (parsed.success) {
      logRun(from, to, base, result);
      return { ...base, verdict: parsed.data };
    }
    failure = `structured_output failed local validation: ${parsed.error.message}`;
  } else if (result && result.subtype !== "success") {
    failure = `agent ended with ${result.subtype}${"errors" in result ? `: ${result.errors.join("; ")}` : ""}`;
  } else if (result) {
    failure = "agent finished without a structured output";
  } else {
    failure = `agent run failed: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
  }

  console.error(`[agent] ${from} -> ${to} FAILED (${durationMs}ms): ${failure}`);
  return { ...base, verdict: fallback(), failure };
}

function logRun(from: string, to: string, base: Omit<VerdictRun, "verdict">, result: SDKResultMessage) {
  const tokens = Object.values(result.modelUsage)
    .map((u) => `${u.inputTokens}in/${u.outputTokens}out/${u.cacheReadInputTokens}cached`)
    .join(", ");
  const total = usageSummary().costUsd;
  console.log(
    `[agent] ${from} -> ${to} · ${result.num_turns} turns · ${base.durationMs}ms (${result.duration_api_ms}ms in API) · ${tokens} · ` +
      `$${base.costUsd.toFixed(5)} this call · $${total.toFixed(5)} total`,
  );
}
