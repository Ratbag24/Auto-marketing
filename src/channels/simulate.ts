import { createHash } from "node:crypto";
import type { ContentItem } from "../db/types.js";
import type { FetchedMetrics } from "./types.js";

/**
 * Deterministic stand-in for a live channel.
 *
 * Its only job is to let the full pipeline - plan, publish, measure, optimise -
 * be exercised before any platform access is granted. Every number it produces
 * is flagged `simulated: true`, stored as such, and labelled in the dashboard.
 * It is never presented as real audience behaviour.
 */

function seededUnit(seed: string): number {
  const hash = createHash("sha256").update(seed).digest();
  // First four bytes as a uint32, scaled to [0, 1).
  return hash.readUInt32BE(0) / 2 ** 32;
}

export function simulatedExternalId(item: ContentItem): string {
  return `sim_${item.channel}_${item.id.slice(-12)}`;
}

/** Audience size by channel, so the shape of the numbers is at least plausible. */
const BASE_REACH: Record<string, number> = {
  email: 1200,
  x: 900,
  linkedin: 1500,
  facebook: 1100,
  instagram: 1800,
};

export function simulateMetrics(
  item: ContentItem,
  asOf: Date = new Date(),
): FetchedMetrics {
  const base = BASE_REACH[item.channel] ?? 1000;
  const r = (salt: string) => seededUnit(`${item.id}:${salt}`);

  // Let elapsed time matter, so metrics grow between sweeps like real ones.
  const publishedAt = item.published_at
    ? new Date(item.published_at).getTime()
    : Date.now();
  const hoursLive = Math.max(0, (asOf.getTime() - publishedAt) / 3_600_000);
  const maturity = Math.min(1, hoursLive / 48);

  const impressions = Math.round(base * (0.6 + r("imp") * 0.8) * maturity);
  const engagementRate = 0.01 + r("eng") * 0.05;
  const engaged = Math.round(impressions * engagementRate);

  if (item.channel === "email") {
    const opens = Math.round(impressions * (0.2 + r("open") * 0.25));
    const clicks = Math.round(opens * (0.05 + r("click") * 0.15));
    return {
      impressions,
      opens,
      clicks,
      reactions: 0,
      shares: 0,
      comments: 0,
      conversions: Math.round(clicks * (0.02 + r("conv") * 0.08)),
      simulated: true,
    };
  }

  const clicks = Math.round(engaged * 0.35);
  return {
    impressions,
    opens: 0,
    clicks,
    reactions: Math.round(engaged * 0.45),
    shares: Math.round(engaged * 0.1),
    comments: Math.round(engaged * 0.1),
    conversions: Math.round(clicks * (0.01 + r("conv") * 0.05)),
    simulated: true,
  };
}
