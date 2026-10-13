import { getBusiness, latestMetricsByItem, listContentItems } from "../db/index.js";
import { localHour, safeTimeZone } from "../util/timezone.js";
import type { Channel, ContentItem, MetricRow } from "../db/types.js";

/**
 * Turns measured performance into guidance for the next planning run.
 *
 * Everything here is deliberately simple arithmetic over the metrics table.
 * The model does the creative work; this module decides what the evidence says,
 * so the strategy is reproducible and auditable rather than vibes.
 */

export interface SegmentPerformance {
  key: string;
  items: number;
  impressions: number;
  engagements: number;
  conversions: number;
  engagement_rate: number;
}

export interface PerformanceReport {
  /** True when there is not yet enough data to steer on. */
  cold_start: boolean;
  items_measured: number;
  simulated_share: number;
  totals: {
    impressions: number;
    engagements: number;
    conversions: number;
    engagement_rate: number;
  };
  by_channel: SegmentPerformance[];
  by_pillar: SegmentPerformance[];
  by_hour: SegmentPerformance[];
  top_items: { pillar: string; channel: Channel; rate: number; excerpt: string }[];
  weak_items: { pillar: string; channel: Channel; rate: number; excerpt: string }[];
}

/** Clicks and social actions count as engagement; opens are too noisy to trust. */
export function engagementsOf(m: MetricRow): number {
  return m.clicks + m.reactions + m.shares + m.comments;
}

function rate(engagements: number, impressions: number): number {
  return impressions > 0 ? engagements / impressions : 0;
}

function summarise(
  groups: Map<string, { items: number; imp: number; eng: number; conv: number }>,
): SegmentPerformance[] {
  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      items: g.items,
      impressions: g.imp,
      engagements: g.eng,
      conversions: g.conv,
      engagement_rate: rate(g.eng, g.imp),
    }))
    .sort((a, b) => b.engagement_rate - a.engagement_rate);
}

/** Minimum measured posts before performance is allowed to steer strategy. */
export const COLD_START_THRESHOLD = 8;

export function buildPerformanceReport(businessId: string): PerformanceReport {
  const metrics = latestMetricsByItem(businessId);
  const timeZone = safeTimeZone(getBusiness(businessId)?.timezone);
  const items = listContentItems(businessId, { limit: 500 });
  const byId = new Map<string, ContentItem>(items.map((i) => [i.id, i]));

  const channels = new Map<string, { items: number; imp: number; eng: number; conv: number }>();
  const pillars = new Map<string, { items: number; imp: number; eng: number; conv: number }>();
  const hours = new Map<string, { items: number; imp: number; eng: number; conv: number }>();

  let impressions = 0;
  let engagements = 0;
  let conversions = 0;
  let simulated = 0;

  const scored: { item: ContentItem; rate: number }[] = [];

  for (const m of metrics) {
    const item = byId.get(m.content_item_id);
    if (!item) continue;

    const eng = engagementsOf(m);
    impressions += m.impressions;
    engagements += eng;
    conversions += m.conversions;
    if (m.simulated === 1) simulated += 1;

    const bump = (
      map: Map<string, { items: number; imp: number; eng: number; conv: number }>,
      key: string,
    ) => {
      const cur = map.get(key) ?? { items: 0, imp: 0, eng: 0, conv: 0 };
      cur.items += 1;
      cur.imp += m.impressions;
      cur.eng += eng;
      cur.conv += m.conversions;
      map.set(key, cur);
    };

    bump(channels, item.channel);
    bump(pillars, item.pillar);
    if (item.published_at) {
      // Bucketed in the business's local time so "best hour" means the same
      // thing here as it does in the plan.
      bump(hours, String(localHour(item.published_at, timeZone)).padStart(2, "0"));
    }

    scored.push({ item, rate: rate(eng, m.impressions) });
  }

  scored.sort((a, b) => b.rate - a.rate);
  const excerpt = (s: string) => s.replace(/\s+/g, " ").slice(0, 120);

  return {
    cold_start: metrics.length < COLD_START_THRESHOLD,
    items_measured: metrics.length,
    simulated_share: metrics.length > 0 ? simulated / metrics.length : 0,
    totals: {
      impressions,
      engagements,
      conversions,
      engagement_rate: rate(engagements, impressions),
    },
    by_channel: summarise(channels),
    by_pillar: summarise(pillars),
    by_hour: summarise(hours).sort((a, b) => a.key.localeCompare(b.key)),
    top_items: scored.slice(0, 5).map(({ item, rate: r }) => ({
      pillar: item.pillar,
      channel: item.channel,
      rate: r,
      excerpt: excerpt(item.subject ?? item.body),
    })),
    weak_items: scored
      .slice(-3)
      .reverse()
      .map(({ item, rate: r }) => ({
        pillar: item.pillar,
        channel: item.channel,
        rate: r,
        excerpt: excerpt(item.subject ?? item.body),
      })),
  };
}

const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

/**
 * Renders the report as the compact brief the planner reads. Kept as text
 * rather than raw JSON so the signal is legible and cheap in tokens.
 */
export function renderPerformanceBrief(report: PerformanceReport): string {
  if (report.cold_start) {
    return `PERFORMANCE DATA: insufficient. Only ${report.items_measured} \
measured posts so far (need ${COLD_START_THRESHOLD}). Treat this cycle as \
deliberate exploration: spread coverage evenly across pillars, channels and \
posting times so the next cycle has signal to learn from. Do not concentrate \
on any one bet yet.`;
  }

  const lines: string[] = [];
  lines.push(
    `PERFORMANCE DATA (${report.items_measured} measured posts, ` +
      `overall engagement rate ${pct(report.totals.engagement_rate)}, ` +
      `${report.totals.conversions} conversions):`,
  );

  if (report.simulated_share > 0) {
    lines.push(
      `NOTE: ${pct(report.simulated_share)} of these measurements come from ` +
        `channels running in simulation mode and are not real audience ` +
        `behaviour. Weight them accordingly.`,
    );
  }

  lines.push("\nBy channel (best first):");
  for (const c of report.by_channel) {
    lines.push(
      `  ${c.key}: ${pct(c.engagement_rate)} over ${c.items} posts, ` +
        `${c.conversions} conversions`,
    );
  }

  lines.push("\nBy content pillar (best first):");
  for (const p of report.by_pillar) {
    lines.push(`  ${p.key}: ${pct(p.engagement_rate)} over ${p.items} posts`);
  }

  const bestHours = [...report.by_hour]
    .sort((a, b) => b.engagement_rate - a.engagement_rate)
    .slice(0, 4);
  if (bestHours.length > 0) {
    lines.push(
      "\nBest posting hours (local time): " +
        bestHours.map((h) => `${h.key}:00 (${pct(h.engagement_rate)})`).join(", "),
    );
  }

  if (report.top_items.length > 0) {
    lines.push("\nStrongest recent pieces:");
    for (const t of report.top_items) {
      lines.push(`  [${t.channel}/${t.pillar}] ${pct(t.rate)} - "${t.excerpt}"`);
    }
  }

  if (report.weak_items.length > 0) {
    lines.push("\nWeakest recent pieces:");
    for (const w of report.weak_items) {
      lines.push(`  [${w.channel}/${w.pillar}] ${pct(w.rate)} - "${w.excerpt}"`);
    }
  }

  lines.push(
    `\nShift weight toward what is working and cut what is not, but keep at ` +
      `least 20% of this cycle exploring untested angles so performance does ` +
      `not collapse into a single repeated format.`,
  );

  return lines.join("\n");
}
