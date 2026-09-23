// Step 3 harness: runs the full agent against real TfL + Bedrock for hardcoded pairs.
// Usage: bun --use-system-ca run scripts/probe-agent.ts ["From" "To"]

import { runVerdict } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { usageSummary } from "../src/usage.ts";

const config = loadConfig();

const [argFrom, argTo] = process.argv.slice(2);
const pairs: Array<[string, string]> =
  argFrom && argTo
    ? [[argFrom, argTo]]
    : [
        ["Oxford Circus", "Canary Wharf"],
        // Rides the Northern line through Kennington to Battersea — pick a pair on whatever
        // line is disrupted when you run this.
        ["Euston", "Battersea Power Station"],
      ];

for (const [from, to] of pairs) {
  console.log(`\n=== ${from} -> ${to} ===`);
  const run = await runVerdict(from, to, config);
  console.log(JSON.stringify(run, null, 2));
}

console.log("\n=== usage ===");
console.log(JSON.stringify(usageSummary(), null, 2));
