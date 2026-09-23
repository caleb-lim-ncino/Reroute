import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { overrideDisruptionDetail, overrideLineStatus } from "./demo.ts";
import { getJourneyOptions, getLineDisruptionDetail, getLineStatus, resolveStation, TflApiError } from "./tfl.ts";

export const TFL_SERVER_NAME = "tfl";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// Composes the error the model reads, so it can tell "TfL rejected this input" (fix the
// arguments) apart from "TfL is unreachable" (lower confidence, don't retry forever).
async function run(label: string, fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await fn()) }] };
  } catch (err) {
    const detail =
      err instanceof TflApiError
        ? `${err.kind === "http" ? "TfL rejected the request" : "TfL was unreachable"} (${err.kind}): ${err.message}`
        : `Unexpected failure: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: "text", text: `${label} failed. ${detail}` }], isError: true };
  }
}

const readOnly = { annotations: { readOnlyHint: true } };

export function createTflServer(appKey: string) {
  return createSdkMcpServer({
    name: TFL_SERVER_NAME,
    version: "1.0.0",
    // Only four tools — deferring their schemas behind tool search would just add a round-trip.
    alwaysLoad: true,
    tools: [
      tool(
        "resolve_station",
        "Resolve a free-text London station name to up to 3 candidate StopPoint ids (Tube, Overground, Elizabeth line or DLR). Every id returned can be passed straight to get_journey_options.",
        { query: z.string().describe("Station name as the commuter typed it, e.g. 'Oxford Circus'") },
        (args) => run("resolve_station", () => resolveStation(args.query, appKey)),
        readOnly,
      ),
      tool(
        "get_journey_options",
        "Plan journeys between two StopPoint ids. Returns 'usual' (the normal-day route: same time next week) and 'live' (what the planner suggests right now, already routed around disruptions), each with mode-by-mode legs. Live options are the only valid alternatives.",
        {
          fromId: z.string().describe("Origin StopPoint id from resolve_station"),
          toId: z.string().describe("Destination StopPoint id from resolve_station"),
        },
        (args) => run("get_journey_options", () => getJourneyOptions(args.fromId, args.toId, appKey)),
        readOnly,
      ),
      tool(
        "get_line_status",
        "Get live status for one or more lines. statusSeverity 10 is Good Service; lower is worse. A line can carry several statuses at once, each covering a different section. Each status includes reportedAt (when TfL first logged it) and expectedEnd (when TfL expects it to clear); either can be null if TfL hasn't given a time — tell the commuter 'unknown' rather than guessing.",
        { lineIds: z.array(z.string()).min(1).describe("Line ids from journey legs, e.g. ['central', 'jubilee']") },
        (args) => run("get_line_status", async () => overrideLineStatus(await getLineStatus(args.lineIds, appKey))),
        readOnly,
      ),
      tool(
        "get_line_disruption_detail",
        "Get the cause of a line's disruption: planned engineering works, signal failure, suspension, etc. Call it when the cause changes how a commuter should react. Each entry includes reportedAt (when TfL first logged it) and expectedEnd (when TfL expects it to clear); either can be null if TfL hasn't given a time — tell the commuter 'unknown' rather than guessing.",
        { lineId: z.string().describe("A single line id, e.g. 'northern'") },
        (args) =>
          run("get_line_disruption_detail", async () =>
            overrideDisruptionDetail(args.lineId, await getLineDisruptionDetail(args.lineId, appKey)),
          ),
        readOnly,
      ),
    ],
  });
}
