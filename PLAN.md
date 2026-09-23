# Reroute — Architecture & Build Plan

Written for: the engineer(s) implementing this (including the Sonnet coding agent).

A web app that takes a London Tube from/to pair, plans a route, checks live line status
against it, and returns a plain-English verdict on whether the usual route still holds.

---

## 1. Decisions locked (and why)

### 1.1 Runtime: long-lived Bun process, **not** Cloudflare Workers

The original spec asked for Bun + Hono + Claude Agent SDK on Cloudflare Workers. That
combination is impossible. The Claude Agent SDK works by **spawning the Claude Code
binary as a subprocess** (`executable: 'node' | 'bun' | 'deno'`,
`pathToClaudeCodeExecutable`). Cloudflare Workers has no process spawning.

Resolution: keep the Agent SDK, drop Workers. Consequences that ripple through the spec:

| Spec said | Actual |
|---|---|
| Cloudflare Workers + `wrangler` | Bun process; container deploy (Fly.io / Railway) or local for the demo |
| `.dev.vars` + `wrangler secret put` | `.env` (Bun auto-loads it) + platform secrets at deploy |
| `c.env.<NAME>` in handlers | `process.env.<NAME>`, read once at startup into a validated config object |
| KV namespace / Durable Object cache | in-process TTL `Map` (single process, 30–60s TTL — plenty for a demo) |

No `wrangler.toml`, no `wrangler.jsonc`. `.env` goes in `.gitignore` before anything else.

### 1.2 Bedrock: only **application inference profiles** are invokable

Verified against the `genai` account (`714322698969`, `us-east-1`):

- `us.anthropic.claude-haiku-4-5-20251001-v1:0` → `AccessDeniedException`, **explicit deny
  in service control policy** `p-9cv7o7z3`
- `arn:aws:bedrock:us-east-1:714322698969:application-inference-profile/e3c8ajgefxsj`
  (Haiku 4.5) → works, 677 ms, returns `usage` token counts

So `VERDICT_MODEL_ID` must be an application-inference-profile ARN, never a bare model ID.
Known-good ARNs already present in the shell environment:

| Model | ARN |
|---|---|
| Haiku 4.5 | `arn:aws:bedrock:us-east-1:714322698969:application-inference-profile/e3c8ajgefxsj` |
| Sonnet 5 | `arn:aws:bedrock:us-east-1:714322698969:application-inference-profile/2h8v82mbrax9` |
| Opus 5 | `arn:aws:bedrock:us-east-1:714322698969:application-inference-profile/qx54tws0g4uy` |

**This kills the OpenAI-on-Bedrock half of the stretch router.** `gpt-oss` / GPT-5-mini
have no application inference profile provisioned in this account, and the SCP denies
direct `InvokeModel`. The cost-router stretch goal becomes Haiku↔Sonnet only (§6).

### 1.3 AWS credentials: SSO, not static keys

The available credentials are AWS SSO (`AWS_PROFILE`, `sso_session = genai`) — temporary
and expiring. There is no long-lived `AWS_ACCESS_KEY_ID` to put in `.env`.

- **Local / demo:** `aws sso login --profile genai`, then set `AWS_PROFILE=genai` in `.env`.
  The Agent SDK subprocess inherits the environment and resolves the SSO cache itself.
  Re-run `aws sso login` if the demo spans a session expiry.
- **Container deploy:** SSO cache won't exist. Either attach an IAM role with
  `bedrock:InvokeModel` on the profile ARN, or mint an IAM user and pass
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` as platform secrets.
  Prefer the role.

The config layer must accept **either** shape: `AWS_PROFILE`, or the explicit key trio.
Fail fast at startup with a clear message if neither is present.

### 1.4 Model choice: Haiku 4.5 for the verdict

The model's input is already clean structured JSON from TfL. This is summarize-and-phrase,
not multi-step reasoning. Haiku 4.5 via `VERDICT_MODEL_ID`, swappable without a code change.

---

## 2. Shape of the thing

```
┌─ Bun process ─────────────────────────────────────────────────────┐
│                                                                   │
│  Hono app                                                         │
│    GET  /            → full HTML page (Pico.css CDN + htmx CDN)  │
│    POST /plan        → HTML fragment: the verdict card            │
│    GET  /usage       → HTML fragment: running token/cost total    │
│    GET  /healthz     → config sanity, no secrets                  │
│                                                                   │
│  agent.ts — runVerdict({ from, to })                              │
│    query() from @anthropic-ai/claude-agent-sdk                    │
│      model:        VERDICT_MODEL_ID (app inference profile ARN)   │
│      mcpServers:   { tfl: tflServer }      ← in-process, 4 tools  │
│      allowedTools: ["mcp__tfl__*"]                                │
│      tools:        []      ← strip ALL built-ins                  │
│      settingSources: []    ← ignore ~/.claude and ./.claude       │
│      outputFormat: { type: 'json_schema', schema: VerdictSchema } │
│      systemPrompt: the reasoning contract (§4)                    │
│    └─ spawns Claude Code binary ──► Bedrock (CLAUDE_CODE_USE_BEDROCK=1)
│                                                                   │
│  tfl.ts — 4 raw API functions + cache                             │
│    resolveStation / getJourneyOptions                             │
│    getLineStatus  / getLineDisruptionDetail                       │
│    cache.ts — TTL Map, 45s default                                │
│                                                                   │
│  usage.ts — token ledger, cost from configurable per-MTok rates   │
└───────────────────────────────────────────────────────────────────┘
```

### File layout

```
Reroute/
├── .env                  (gitignored — never committed)
├── .env.example          (committed, no values)
├── .gitignore
├── package.json
├── tsconfig.json
├── README.md
├── PLAN.md               (this file)
└── src/
    ├── index.ts          Hono app + server entry
    ├── config.ts         env → validated Config, fail fast
    ├── tfl.ts            4 TfL API functions, typed
    ├── tfl-types.ts      narrow types for the TfL shapes we consume
    ├── cache.ts          TTL Map
    ├── tools.ts          tool() defs + createSdkMcpServer
    ├── agent.ts          runVerdict(): query() + outputFormat
    ├── schema.ts         Zod VerdictSchema + draft-7 JSON Schema
    ├── usage.ts          token/cost ledger
    └── views.ts          page shell + verdict-card fragment (template strings)
└── scripts/
    ├── probe-tfl.ts      manual harness for step 2
    └── probe-agent.ts    CLI harness for step 3
```

---

## 3. The four TfL tools

Base `https://api.tfl.gov.uk`, `?app_key=${TFL_APP_KEY}` on every call. **No `app_id`.**

| Tool | Endpoint | Notes |
|---|---|---|
| `resolve_station(query)` | `GET /StopPoint/Search/{query}` | Filter to `modes` containing `tube`. Return top ~3 `{id, name}` so the model can disambiguate, not just the first hit. |
| `get_journey_options(fromId, toId)` | `GET /Journey/JourneyResults/{from}/to/{to}` | Returns fat JSON. **Project it down** in the handler to `{duration, legs: [{mode, lineId, lineName, departurePoint, arrivalPoint, duration}]}` before handing it to the model. |
| `get_line_status(lineIds[])` | `GET /Line/{ids}/Status` | Comma-join ids. Project to `{lineId, lineName, statusSeverity, statusSeverityDescription, reason}`. |
| `get_line_disruption_detail(lineId)` | `GET /Line/{id}/Disruption` | For *why*: planned engineering vs signal failure vs suspension. Commuters react differently to each. |

Every handler must:

- Attach a **fetch timeout** (`AbortSignal.timeout(8000)`) — a hung TfL call otherwise hangs the whole request.
- Include a `fetchedAt` ISO timestamp in the returned payload. The model needs this to
  decide `confidence` (§4).
- Return `isError: true` with a composed message on non-2xx or network failure, so the
  model reads something actionable instead of a bare exception. It must be able to tell
  "TfL returned 404 for that station" apart from "TfL is down".
- Be annotated `readOnlyHint: true` so the model can batch calls in parallel.

Journey planning also needs a bus/walk-allowing variant for alternatives — pass
`mode=tube,bus,walking,overground,dlr,elizabeth-line` as a query param on
`get_journey_options` rather than adding a fifth tool.

### Caching

`cache.ts`: `Map<string, {value: unknown, expiresAt: number}>`, key = full request URL,
TTL 45 s, lazy eviction on read. Wrap the raw `fetch` in `tfl.ts`, so all four tools get
it for free. Log cache hit/miss — it's a visible demo detail.

### Tool loading

Tool search is on by default and **defers** SDK MCP tool schemas, costing an extra
`ToolSearch` round-trip. With only four tools that's pure latency. Pass `alwaysLoad: true`
via `createSdkMcpServer` options so all four schemas are in the initial prompt.

---

## 4. The reasoning step

### Output schema

`schema.ts` defines it in Zod, then `z.toJSONSchema(Verdict, { target: "draft-7" })` —
the SDK validates against **draft-07** and rejects newer declarations. Zod defaults to
draft 2020-12, so the `target` argument is not optional.

```ts
const Verdict = z.object({
  verdict: z.string(),                        // one plain-English platform sentence
  is_disrupted: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  minutes_lost: z.number(),                   // vs a normal day, 0 if none
  alternative_summary: z.string().nullable(), // null if not needed
});
```

All five fields required, matching the spec's schema exactly. `alternative_summary` uses
`z.string().nullable()` → `"type": ["string", "null"]`.

### System prompt contract

Instruct the agent to:

1. Resolve both stations to StopPoint IDs.
2. Plan the journey; collect every line the route touches.
3. Check live status for all of those lines in one `get_line_status` call.
4. If anything is below Good Service, **judge whether a commuter would actually notice**.
   A 2-minute Minor Delay on one leg is not a Severe Delay on the interchange line. Call
   `get_line_disruption_detail` when the *cause* changes the answer — planned engineering
   is predictable, a signal failure is not.
5. Only fetch an alternative route if the disruption is genuinely noticeable, and allow
   bus/walking legs.
6. Set `confidence: "low"` whenever a TfL response was missing, errored, or its
   `fetchedAt` is more than ~3 minutes old. **Never silently trust stale data.**

Keep it tight. Haiku follows a short explicit contract better than a long discursive one.

### Guarding the result

Treat a result as usable **only** when `subtype === "success"` **and** `structured_output`
is present. Three distinct failure modes to handle, all of which must render a card rather
than a 500:

- `subtype === "error_max_structured_output_retries"` → couldn't produce valid output
- `subtype === "success"` with no `structured_output` → run finished without one
- a thrown error from `query()` → process/connection failure

Each degrades to a `confidence: "low"` card that says the check couldn't complete. A demo
that shows a graceful "couldn't verify — treat as unknown" beats one that shows a stack trace.

---

## 5. Cost tracking

The `result` message carries `usage` (input/output tokens) and `total_cost_usd`. **On
Bedrock, `total_cost_usd` is unreliable or zero** — the SDK prices against first-party
rates, not your Bedrock contract. So compute it locally:

```
RATE_INPUT_PER_MTOK   (default 1.00)   # Haiku 4.5 on Bedrock
RATE_OUTPUT_PER_MTOK  (default 5.00)
```

Both env-configurable, both logged. `usage.ts` keeps a process-lifetime ledger:
`{ calls, inputTokens, outputTokens, costUsd, byModel: Record<string, ...> }`. Also record
`cache_read_input_tokens` if present — cache reads are much cheaper and ignoring them
overstates the bill.

Surface the running total in the page footer via `GET /usage`, and log per-request:
`model · in/out tokens · $ this call · $ total`.

---

## 6. Stretch: the cost router (only after 1–7 below all work)

The Agent SDK can't hot-swap models mid-loop, so the honest version is two stages:

1. **Stage 1 — Haiku agent** (always). Gathers TfL facts, decides `is_disrupted`,
   produces the full verdict.
2. **Stage 2 — conditional escalation.** If `is_disrupted === true` *and* an alternative
   route is in play, re-phrase with Sonnet 5 (a single Bedrock Converse call, no tool loop
   — the facts are already gathered). If `is_disrupted === false`, ship Haiku's sentence
   as-is; there is nothing to reason about.

Log which model handled each request in the ledger so it reads as a cost-optimization
story, not an internal detail. Routing table on the page: *"clean route → Haiku, $0.0002;
disruption + alternative → Sonnet, $0.0018."*

Scope note: OpenAI models are **out** — no application inference profile, SCP denies
direct invoke (§1.2).

---

## 7. Build order

Each step ends in something runnable. Do not proceed past a step that doesn't run.

1. **Skeleton.** `package.json`, `tsconfig.json`, `.gitignore` (with `.env` in it *first*),
   `.env.example`, `config.ts` with fail-fast validation, Hono app serving `GET /healthz`
   and a stub `GET /`. Verify: `bun run dev`, curl both.
2. **TfL tools in isolation, no AI.** Implement `tfl.ts` + `cache.ts` + `tfl-types.ts`.
   `scripts/probe-tfl.ts` hits all four real endpoints and prints the projected shapes.
   Verify: run it, confirm shapes, confirm second run is a cache hit. **Needs `TFL_APP_KEY`.**
3. **Agent end to end from the CLI.** `schema.ts`, `tools.ts`, `agent.ts`,
   `scripts/probe-agent.ts` with hardcoded pairs — one clean route, one on a
   currently-disrupted line. Verify: valid `structured_output`, and check the
   `error_max_structured_output_retries` path by temporarily tightening the schema.
4. **Cache layer verification.** Already built in step 2; here, confirm repeated demo
   queries don't re-hit TfL and don't re-invoke Claude unnecessarily.
5. **The page.** `views.ts` + `GET /` + `POST /plan`. One form (from/to), htmx swaps in
   the verdict card. Pico.css classless via CDN, minimal custom CSS. Include an
   `hx-indicator` — the agent call takes seconds and a dead form looks broken.
6. **Usage display.** `usage.ts` wired into `agent.ts`; footer fragment via `GET /usage`,
   `hx-trigger="load, every 10s"`.
7. **Deploy + real run-through.** Dockerfile, deploy to Fly.io or Railway with an IAM
   role or IAM-user secrets (§1.3). Full run against a real, currently-disrupted London
   line.

---

## 8. Things that will bite

Found during the build (steps 1–6):

- **Zscaler re-signs TLS on this network.** Bun doesn't trust the macOS keychain by
  default, so every TfL fetch fails with `unable to get local issuer certificate`. All
  package scripts run `bun --use-system-ca`. `NODE_EXTRA_CA_CERTS` in `.env` does *not*
  work, because Bun loads `.env` after TLS is initialised.
- **TfL search returns hub ids** (`HUBCAW`) that the Journey Planner answers with HTTP 300
  disambiguation. `resolveStation` expands hubs to their tube child via `/StopPoint/{hub}`.
- **Cache hits must keep the original `fetchedAt`.** Otherwise the staleness check behind
  `confidence: "low"` can never fire.
- **Latency is model-bound**, not spawn-bound: ~17s total, ~13s of it in the API across
  6–7 sequential turns. Pre-warming with `startup()` would save only ~3s, and its handle is
  single-use, so it isn't wired in.
- **The Journey Planner is disruption-aware.** Asked "now", it silently routes around a
  suspended line, so its fastest option is a detour, not the usual route. With the Windrush
  line suspended, Canada Water → Crystal Palace came back as a 64-min Jubilee/Northern/
  Victoria/bus trip and the agent said "route holds up". Fix: `get_journey_options` also
  asks for the same London time one week ahead (rounded to 15 min so it caches) and
  returns `usual` (normal day) next to `live` (right now), with TfL's per-leg
  `isDisrupted`. Caveat: if next week has planned works, the baseline inherits them.
- **The alternative route can hallucinate.** Before the `usual`/`live` split the model
  sometimes invented an alternative it had no data for (it once put Vauxhall on the
  Northern line). Now it must pick a `live` option by index (`recommended_live_option`),
  and the page draws that exact TfL journey rather than trusting the prose.
- **`/StopPoint/Mode/{modes}` times out** (504 after ~60s). The autocomplete index is
  built from `/Line/{id}/StopPoints` per line instead: ~420 stations in ~1s, merged per hub.
- **Live crowding (`/crowding/{naptan}/Live`) only covers Underground (940G…) ids.**
  Everything else returns `dataAvailable: false`; the chip just doesn't render.
- **The SDK's `env` option replaces the subprocess environment** instead of merging.
  `agent.ts` builds it explicitly, drops empty values (an empty `AWS_ACCESS_KEY_ID` shadows
  the SSO profile), and pins every model slot to the verdict profile ARN.

Anticipated at planning time:

- **Cold-start latency.** Every `query()` spawns the Claude Code binary (~1–3 s). Call
  the SDK's `startup()` once at boot to pre-warm, or the first demo request looks broken.
- **`settingSources: []` is not the default.** Without it the SDK loads skills, commands,
  and memory from `~/.claude/` and `./.claude/` — the developer's personal config leaking
  into a server app's behaviour. Set it explicitly.
- **`tools: []` to strip built-ins.** Otherwise the agent has Read/Write/Bash/WebFetch and
  may go wandering instead of using the TfL tools. `tools: []` removes every built-in;
  MCP tools are unaffected.
- **SSO expiry mid-demo.** `aws sso login --profile genai` immediately before demoing.
- **TfL `Journey` responses are enormous.** Project them down in the handler. Feeding raw
  TfL JSON to the model wastes most of the context and degrades the verdict.
- **A "currently-disrupted line" is not on demand.** Weekend engineering works are the
  reliable source. Keep a recorded fixture from a real disrupted response so the demo has
  a fallback if every line is on Good Service at showtime.
