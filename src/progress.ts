// Live progress for in-flight verdicts, keyed by a client-generated request id. The page
// polls it to drive the loading gauge from the agent's real tool calls, not a fake timer.

export const STAGES = ["Finding stations", "Planning route", "Checking lines", "Reading notices", "Writing verdict"];

interface Progress {
  stage: number;
  updatedAt: number;
}

const inFlight = new Map<string, Progress>();
const MAX_AGE_MS = 5 * 60 * 1000;

// Stages only move forward: parallel or repeated tool calls must not send the train backwards.
export function advance(rid: string, stage: number): void {
  const current = inFlight.get(rid);
  if (current && current.stage >= stage) return;
  inFlight.set(rid, { stage, updatedAt: Date.now() });
}

export function progressOf(rid: string): Progress | undefined {
  return inFlight.get(rid);
}

export function finish(rid: string): void {
  inFlight.delete(rid);
}

// Belt and braces for requests whose client vanished before finish() ran.
setInterval(() => {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [rid, p] of inFlight) if (p.updatedAt < cutoff) inFlight.delete(rid);
}, 60_000).unref();
