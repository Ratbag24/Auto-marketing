/**
 * Central configuration. Everything is read once at startup so a misconfigured
 * deploy fails loudly here rather than halfway through a publish sweep.
 */

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export type Effort = "low" | "medium" | "high" | "max";

export const config = {
  port: num("PORT", 8787),
  databasePath: str("DATABASE_PATH", "./data/autopilot.db"),
  adminToken: str("ADMIN_TOKEN"),

  model: str("MODEL", "claude-opus-5-5"),
  // 'xhigh' is a valid API value but @anthropic-ai/sdk 0.73 does not yet type
  // it; widen this union once the SDK catches up.
  plannerEffort: str("PLANNER_EFFORT", "high") as Effort,

  // Public origin this server is reachable at. The tracking snippet points
  // here, so it must be the address a visitor's browser can resolve.
  publicUrl: str("PUBLIC_URL", ""),

  publishIntervalMinutes: num("PUBLISH_INTERVAL_MINUTES", 5),
  monitorIntervalMinutes: num("MONITOR_INTERVAL_MINUTES", 5),
  crawlIntervalHours: num("CRAWL_INTERVAL_HOURS", 168),
  metricsIntervalMinutes: num("METRICS_INTERVAL_MINUTES", 60),
  planIntervalHours: num("PLAN_INTERVAL_HOURS", 168),
  publishingEnabled: bool("PUBLISHING_ENABLED", true),

  channels: {
    email: {
      apiKey: str("RESEND_API_KEY"),
      from: str("EMAIL_FROM"),
    },
    x: {
      apiKey: str("X_API_KEY"),
      apiSecret: str("X_API_SECRET"),
      accessToken: str("X_ACCESS_TOKEN"),
      accessSecret: str("X_ACCESS_SECRET"),
    },
    linkedin: {
      accessToken: str("LINKEDIN_ACCESS_TOKEN"),
      orgUrn: str("LINKEDIN_ORG_URN"),
    },
    meta: {
      accessToken: str("META_ACCESS_TOKEN"),
      pageId: str("META_PAGE_ID"),
      igUserId: str("META_IG_USER_ID"),
    },
  },
} as const;

export type Config = typeof config;
