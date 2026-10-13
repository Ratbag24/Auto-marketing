import { adapterFor } from "../channels/registry.js";
import {
  itemsNeedingMetrics,
  logEvent,
  recordMetrics,
} from "../db/index.js";

export interface MetricsSweepResult {
  polled: number;
  recorded: number;
  failed: number;
}

/**
 * Polls every recently published item for fresh numbers.
 *
 * Each sweep appends a row rather than overwriting, so performance is a time
 * series. That is what lets the dashboard show growth and the optimiser see
 * which posts are still accumulating engagement.
 */
export async function runMetricsSweep(): Promise<MetricsSweepResult> {
  const items = itemsNeedingMetrics(200);
  const result: MetricsSweepResult = {
    polled: items.length,
    recorded: 0,
    failed: 0,
  };

  for (const item of items) {
    try {
      const metrics = await adapterFor(item.channel).fetchMetrics(item);
      recordMetrics({
        content_item_id: item.id,
        business_id: item.business_id,
        channel: item.channel,
        impressions: metrics.impressions,
        clicks: metrics.clicks,
        opens: metrics.opens,
        reactions: metrics.reactions,
        shares: metrics.shares,
        comments: metrics.comments,
        conversions: metrics.conversions,
        simulated: metrics.simulated ? 1 : 0,
      });
      result.recorded += 1;
    } catch (err) {
      result.failed += 1;
      logEvent(
        "metrics.failed",
        `Metrics fetch failed for ${item.channel} item: ` +
          (err instanceof Error ? err.message : String(err)),
        { businessId: item.business_id, level: "warn", data: { itemId: item.id } },
      );
    }
  }

  return result;
}
