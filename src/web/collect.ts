import {
  classifyReferrer,
  contentItemFromCampaign,
  countryFromHeaders,
  countryFromTimezone,
  parseUserAgent,
  regionFromTimezone,
  visitorHash,
} from "./analytics.js";
import {
  getWebsiteByKey,
  markVerified,
  recordVisit,
  sessionExists,
} from "../db/websites.js";

export interface CollectPayload {
  k?: unknown;
  e?: unknown;
  p?: unknown;
  r?: unknown;
  tz?: unknown;
  lang?: unknown;
  sid?: unknown;
  d?: unknown;
  us?: unknown;
  um?: unknown;
  uc?: unknown;
}

export interface CollectContext {
  ip: string;
  userAgent: string;
  headers: Record<string, string | string[] | undefined>;
}

export type CollectResult =
  | { accepted: true; reason?: string }
  | { accepted: false; reason: string };

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
};

/**
 * Handles one beacon. Returns a result rather than throwing: this endpoint is
 * public and must never give a caller useful information about failures.
 */
export function collect(
  payload: CollectPayload,
  ctx: CollectContext,
): CollectResult {
  const key = str(payload.k, 64);
  if (!key) return { accepted: false, reason: "no key" };

  const site = getWebsiteByKey(key);
  if (!site) return { accepted: false, reason: "unknown key" };

  const agent = parseUserAgent(ctx.userAgent);
  // Bots inflate every number they touch; drop them before they are stored.
  if (agent.device === "bot") return { accepted: false, reason: "bot" };

  const event = str(payload.e, 16) ?? "view";
  const rawPath = str(payload.p, 2048) ?? "/";
  // Keep only the path; query strings carry UTM tags we parse separately and
  // can otherwise contain personal data.
  const path = rawPath.split("?")[0] ?? "/";
  const sessionId = str(payload.sid, 64) ?? "anon";
  const timezone = str(payload.tz, 64);

  // The first beacon proves the snippet is installed correctly.
  markVerified(site.id);

  // A 'leave' event only carries dwell time for an existing visit.
  if (event === "leave") {
    return { accepted: true, reason: "duration only" };
  }

  const referrer = str(payload.r, 2048);
  const { source, host } = classifyReferrer(referrer, site.url);

  const utmCampaign = str(payload.uc, 200);
  const country =
    countryFromHeaders(ctx.headers) ?? countryFromTimezone(timezone);

  const duration = typeof payload.d === "number" && payload.d > 0
    ? Math.min(Math.round(payload.d), 86_400_000)
    : 0;

  recordVisit({
    website_id: site.id,
    business_id: site.business_id,
    visitor_hash: visitorHash(site.id, ctx.ip, ctx.userAgent),
    session_id: sessionId,
    path,
    referrer,
    referrer_source: host ? `${source}:${host}` : source,
    country,
    region: regionFromTimezone(timezone),
    timezone,
    language: str(payload.lang, 16),
    device: agent.device,
    browser: agent.browser,
    os: agent.os,
    utm_source: str(payload.us, 200),
    utm_medium: str(payload.um, 200),
    utm_campaign: utmCampaign,
    content_item_id: contentItemFromCampaign(utmCampaign),
    is_entry: sessionExists(sessionId) ? 0 : 1,
    is_goal:
      site.goal_path && path === site.goal_path.replace(/\/+$/, "") ? 1 : 0,
    duration_ms: duration,
  });

  return { accepted: true };
}
