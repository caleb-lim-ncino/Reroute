// Manual verification harness for step 2. Hits the real TfL API (unauthenticated tier
// works fine for this) and prints the projected shapes so a human can eyeball them.
// Run twice in the same process to prove the cache: the second batch of calls should log
// cache HITs in cache.ts's own console output.

import { loadConfig } from "../src/config.ts";
import { getJourneyOptions, getLineDisruptionDetail, getLineStatus, resolveStation } from "../src/tfl.ts";

const config = loadConfig();
if (!config.tflAppKey) {
  console.log("[probe] TFL_APP_KEY is empty — testing against TfL's unauthenticated tier.\n");
}

async function runOnce(label: string) {
  console.log(`\n=== ${label} ===`);

  const from = await resolveStation("Oxford Circus", config.tflAppKey);
  console.log("resolveStation(Oxford Circus):", JSON.stringify(from, null, 2));

  const to = await resolveStation("Canary Wharf", config.tflAppKey);
  console.log("resolveStation(Canary Wharf):", JSON.stringify(to, null, 2));

  const fromId = from.matches[0]?.id;
  const toId = to.matches[0]?.id;
  if (!fromId || !toId) throw new Error("Could not resolve both stations");

  const journey = await getJourneyOptions(fromId, toId, config.tflAppKey);
  console.log(
    "getJourneyOptions(Oxford Circus -> Canary Wharf):",
    JSON.stringify({ ...journey, live: journey.live.slice(0, 1) }, null, 2),
  );

  const lineIds = [...new Set((journey.usual ?? journey.live[0])?.legs.map((leg) => leg.lineId).filter((id): id is string => !!id))];
  console.log("lines touched by first journey option:", lineIds);

  const status = await getLineStatus(lineIds, config.tflAppKey);
  console.log("getLineStatus:", JSON.stringify(status, null, 2));

  const disrupted = status.lines.find((l) => l.statuses.some((s) => s.statusSeverityDescription !== "Good Service"));
  if (disrupted) {
    const detail = await getLineDisruptionDetail(disrupted.lineId, config.tflAppKey);
    console.log(`getLineDisruptionDetail(${disrupted.lineId}):`, JSON.stringify(detail, null, 2));
  } else {
    console.log("No disrupted line on this route right now — probing disruption detail for 'northern' instead.");
    const detail = await getLineDisruptionDetail("northern", config.tflAppKey);
    console.log("getLineDisruptionDetail(northern):", JSON.stringify(detail, null, 2));
  }
}

await runOnce("first pass (expect cache MISS on every call)");
await runOnce("second pass (expect cache HIT on every call — identical URLs)");
