// Reads process.env once at startup into a validated, immutable config object.
// Fails fast (throws) rather than letting handlers discover missing config at request time.

export type AwsAuth =
  | { kind: "profile"; profile: string; region: string }
  | { kind: "keys"; accessKeyId: string; secretAccessKey: string; region: string };

export interface Config {
  tflAppKey: string; // may be "" — unauthenticated TfL tier
  aws: AwsAuth;
  verdictModelId: string;
  rateInputPerMtok: number;
  rateOutputPerMtok: number;
  port: number;
}

class ConfigError extends Error {}

function resolveAwsAuth(env: Record<string, string | undefined>): AwsAuth {
  const region = env.AWS_REGION?.trim();
  const profile = env.AWS_PROFILE?.trim();
  if (profile) return { kind: "profile", profile, region: region || "us-east-1" };

  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (accessKeyId && secretAccessKey && region) {
    return { kind: "keys", accessKeyId, secretAccessKey, region };
  }

  throw new ConfigError(
    "AWS auth missing: set either AWS_PROFILE (SSO) or all of " +
      "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION.",
  );
}

function parsePositiveNumber(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ConfigError(`${name} must be a non-negative number, got: ${value}`);
  }
  return n;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const aws = resolveAwsAuth(env);

  // Bare Bedrock model ids are denied by an org SCP; only application inference profiles work.
  const verdictModelId = env.VERDICT_MODEL_ID?.trim() ?? "";
  if (!verdictModelId) {
    throw new ConfigError("VERDICT_MODEL_ID missing: set it to a Bedrock application-inference-profile ARN.");
  }

  return {
    tflAppKey: env.TFL_APP_KEY?.trim() ?? "",
    aws,
    verdictModelId,
    rateInputPerMtok: parsePositiveNumber("RATE_INPUT_PER_MTOK", env.RATE_INPUT_PER_MTOK, 1.0),
    rateOutputPerMtok: parsePositiveNumber("RATE_OUTPUT_PER_MTOK", env.RATE_OUTPUT_PER_MTOK, 5.0),
    port: parsePositiveNumber("PORT", env.PORT, 3000),
  };
}
