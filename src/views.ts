import type { VerdictRun } from "./agent.ts";
import type { usageSummary } from "./usage.ts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function page(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Reroute</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.classless.min.css">
  <script src="https://unpkg.com/htmx.org@2.0.4" defer></script>
  <style>
    .htmx-indicator { display: none; }
    .htmx-request .htmx-indicator, .htmx-request.htmx-indicator { display: block; }
    .htmx-request button { pointer-events: none; opacity: .6; }
    [data-status="clear"] { border-left: 6px solid #2e7d32; }
    [data-status="disrupted"] { border-left: 6px solid #c62828; }
    [data-status="unknown"] { border-left: 6px solid #9e9e9e; }
    footer small { display: block; }
  </style>
</head>
<body>
  <header>
    <h1>Reroute</h1>
    <p>Does your usual Tube route still hold up right now?</p>
  </header>
  <main>
    <form hx-post="/plan" hx-target="#result" hx-indicator="#checking">
      <fieldset role="group">
        <input name="from" placeholder="From, e.g. Euston" required autocomplete="off">
        <input name="to" placeholder="To, e.g. Battersea Power Station" required autocomplete="off">
        <button type="submit">Check</button>
      </fieldset>
    </form>
    <p id="checking" class="htmx-indicator" aria-busy="true">Checking live TfL status…</p>
    <section id="result"></section>
  </main>
  <footer id="usage" hx-get="/usage" hx-trigger="load, every 10s, verdict from:body"></footer>
</body>
</html>`;
}

export function verdictCard(from: string, to: string, run: VerdictRun): string {
  const v = run.verdict;
  const status = run.failure || v.confidence === "low" ? "unknown" : v.is_disrupted ? "disrupted" : "clear";
  const headline = { clear: "Route holds up", disrupted: "Disrupted", unknown: "Couldn't verify" }[status];

  const details = [
    v.is_disrupted ? `<li>About <strong>${v.minutes_lost} min</strong> lost vs a normal day</li>` : "",
    v.alternative_summary ? `<li>Alternative: ${esc(v.alternative_summary)}</li>` : "",
    `<li>Confidence: ${esc(v.confidence)}</li>`,
  ].join("");

  return `<article data-status="${status}">
  <header><strong>${headline}</strong> · ${esc(from)} → ${esc(to)}</header>
  <p>${esc(v.verdict)}</p>
  <ul>${details}</ul>
  <footer><small>${(run.durationMs / 1000).toFixed(1)}s · $${run.costUsd.toFixed(4)}</small></footer>
</article>`;
}

export function usageFooter(u: ReturnType<typeof usageSummary>): string {
  if (u.requests === 0) return `<small>No model calls yet.</small>`;
  const perModel = u.models
    .map((m) => {
      const name = m.model.split("/").pop() ?? m.model;
      return `<small>${esc(name)}: ${m.calls} calls · ${m.inputTokens.toLocaleString()} in / ${m.outputTokens.toLocaleString()} out · $${m.costUsd.toFixed(4)}</small>`;
    })
    .join("");
  return `<small><strong>Model spend this session: $${u.costUsd.toFixed(4)}</strong> across ${u.requests} calls</small>${perModel}`;
}
