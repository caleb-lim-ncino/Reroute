import { z } from "zod";

export const Verdict = z.object({
  verdict: z.string().describe("One plain-English sentence a commuter would read on the platform"),
  is_disrupted: z.boolean(),
  confidence: z.enum(["high", "medium", "low"]),
  minutes_lost: z.number().describe("Estimated extra minutes vs a normal day, 0 if none"),
  alternative_summary: z
    .string()
    .nullable()
    .describe("Short description of the best alternative route, null if not needed"),
});

export type Verdict = z.infer<typeof Verdict>;

// The SDK validates against JSON Schema draft-07; Zod emits 2020-12 unless told otherwise.
export const verdictJsonSchema = z.toJSONSchema(Verdict, { target: "draft-7" });
