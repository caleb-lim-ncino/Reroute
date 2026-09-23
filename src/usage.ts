// Process-lifetime token/cost ledger. The SDK's own costUSD prices against first-party
// Anthropic rates, not the Bedrock contract, so cost is recomputed here from configured rates.

export interface Rates {
  inputPerMtok: number;
  outputPerMtok: number;
}

// Standard prompt-caching multipliers relative to the base input rate.
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

interface ModelTotals extends TokenCounts {
  calls: number;
  costUsd: number;
}

const byModel = new Map<string, ModelTotals>();

export function priceTokens(t: TokenCounts, rates: Rates): number {
  const input =
    t.inputTokens +
    t.cacheReadInputTokens * CACHE_READ_MULTIPLIER +
    t.cacheCreationInputTokens * CACHE_WRITE_MULTIPLIER;
  return (input * rates.inputPerMtok + t.outputTokens * rates.outputPerMtok) / 1_000_000;
}

export function recordUsage(model: string, t: TokenCounts, rates: Rates): number {
  const costUsd = priceTokens(t, rates);
  const totals = byModel.get(model) ?? {
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  totals.calls += 1;
  totals.costUsd += costUsd;
  totals.inputTokens += t.inputTokens;
  totals.outputTokens += t.outputTokens;
  totals.cacheReadInputTokens += t.cacheReadInputTokens;
  totals.cacheCreationInputTokens += t.cacheCreationInputTokens;
  byModel.set(model, totals);
  return costUsd;
}

export function usageSummary() {
  const models = [...byModel.entries()].map(([model, totals]) => ({ model, ...totals }));
  return {
    requests: models.reduce((n, m) => n + m.calls, 0),
    costUsd: models.reduce((n, m) => n + m.costUsd, 0),
    models,
  };
}
