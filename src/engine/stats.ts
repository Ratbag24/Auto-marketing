import { getDb } from "../db/index.js";
import { buildPerformanceReport, type PerformanceReport } from "./optimizer.js";
import {
  enabledChannels,
  getBrandProfile,
  lastPlanRun,
  listContentItems,
} from "../db/index.js";
import type { Business, Channel } from "../db/types.js";

/** Model pricing in USD per million tokens, for the cost readout. */
const PRICING: Record<string, { input: number; output: number; cached: number }> =
  {
    "claude-opus-5-5": { input: 4, output: 20, cached: 0.2 },
    "claude-opus-5": { input: 5, output: 25, cached: 0.5 },
    "claude-sonnet-5-5": { input: 2, output: 10, cached: 0.2 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cached: 0.01 },
  };

export interface DailyPoint {
  date: string;
  impressions: number;
  engagements: number;
  conversions: number;
}

export interface FunnelCounts {
  draft: number;
  scheduled: number;
  published: number;
  failed: number;
  skipped: number;
}

export interface BusinessStats {
  business: Business;
  channels: Channel[];
  pillars: string[];
  performance: PerformanceReport;
  funnel: FunnelCounts;
  daily: DailyPoint[];
  upcoming: {
    id: string;
    channel: Channel;
    pillar: string;
    scheduled_at: string;
    preview: string;
  }[];
  lastPlan: {
    at: string | null;
    status: string | null;
    note: string | null;
    items: number;
  };
  spend: {
    model: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    usd: number;
  };
}

/**
 * Daily totals built from the *latest* metric row per item per day, so repeated
 * polling of the same post does not inflate the series.
 */
export function dailySeries(businessId: string, days = 30): DailyPoint[] {
  const since = new Date(Date.now() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const rows = getDb()
    .prepare(
      `WITH ranked AS (
         SELECT m.*,
                substr(m.captured_at, 1, 10) AS day,
                ROW_NUMBER() OVER (
                  PARTITION BY m.content_item_id, substr(m.captured_at, 1, 10)
                  ORDER BY m.captured_at DESC, m.id DESC
                ) AS rn
         FROM metrics m
         WHERE m.business_id = ? AND substr(m.captured_at, 1, 10) >= ?
       )
       SELECT day AS date,
              SUM(impressions) AS impressions,
              SUM(clicks + reactions + shares + comments) AS engagements,
              SUM(conversions) AS conversions
       FROM ranked
       WHERE rn = 1
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(businessId, since) as unknown as {
    date: string;
    impressions: number | null;
    engagements: number | null;
    conversions: number | null;
  }[];

  return rows.map((r) => ({
    date: r.date,
    impressions: r.impressions ?? 0,
    engagements: r.engagements ?? 0,
    conversions: r.conversions ?? 0,
  }));
}

function funnelCounts(businessId: string): FunnelCounts {
  const rows = getDb()
    .prepare(
      `SELECT status, COUNT(*) AS n FROM content_items
       WHERE business_id = ? GROUP BY status`,
    )
    .all(businessId) as unknown as { status: string; n: number }[];

  const counts: FunnelCounts = {
    draft: 0,
    scheduled: 0,
    published: 0,
    failed: 0,
    skipped: 0,
  };
  for (const r of rows) {
    if (r.status === "publishing") {
      counts.scheduled += r.n;
    } else if (r.status in counts) {
      counts[r.status as keyof FunnelCounts] = r.n;
    }
  }
  return counts;
}

function modelSpend(businessId: string, model: string) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cached_tokens), 0) AS cached_tokens
       FROM plan_runs WHERE business_id = ?`,
    )
    .get(businessId) as unknown as {
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
  };

  const price = PRICING[model] ?? PRICING["claude-opus-5-5"]!;
  // Cached reads are billed at the cache rate; the rest at the input rate.
  const uncachedInput = Math.max(0, row.input_tokens - row.cached_tokens);
  const usd =
    (uncachedInput / 1_000_000) * price.input +
    (row.cached_tokens / 1_000_000) * price.cached +
    (row.output_tokens / 1_000_000) * price.output;

  return { model, ...row, usd };
}

export function buildBusinessStats(
  business: Business,
  model: string,
): BusinessStats {
  const brand = getBrandProfile(business.id);
  const now = Date.now();

  const upcoming = listContentItems(business.id, { limit: 500 })
    .filter(
      (i) =>
        (i.status === "scheduled" || i.status === "draft") &&
        new Date(i.scheduled_at).getTime() >= now,
    )
    .sort(
      (a, b) =>
        new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
    )
    .slice(0, 12)
    .map((i) => ({
      id: i.id,
      channel: i.channel,
      pillar: i.pillar,
      scheduled_at: i.scheduled_at,
      preview: (i.subject ?? i.body).replace(/\s+/g, " ").slice(0, 110),
    }));

  const plan = lastPlanRun(business.id);

  return {
    business,
    channels: enabledChannels(business.id),
    pillars: brand?.pillars.map((p) => p.name) ?? [],
    performance: buildPerformanceReport(business.id),
    funnel: funnelCounts(business.id),
    daily: dailySeries(business.id),
    upcoming,
    lastPlan: {
      at: plan?.started_at ?? null,
      status: plan?.status ?? null,
      note: plan?.strategy_note ?? null,
      items: plan?.items_created ?? 0,
    },
    spend: modelSpend(business.id, model),
  };
}
