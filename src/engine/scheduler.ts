import { config } from "../config.js";
import { planCampaign } from "../ai/planner.js";
import {
  lastPlanRun,
  listBusinesses,
  listContentItems,
  logEvent,
} from "../db/index.js";
import { runMetricsSweep } from "./metrics.js";
import { runPublishSweep } from "./publisher.js";
import { runMonitorSweep } from "../web/monitor.js";
import { crawlWebsite } from "../web/crawler.js";
import { listWebsites } from "../db/websites.js";

/**
 * The whole scheduler. Three timers in one process - no cron daemon, no queue
 * service, no worker fleet. This is what keeps the overhead low enough to run
 * the product on a single small instance.
 */

const MINUTE = 60_000;

type Timer = ReturnType<typeof setInterval>;

let timers: Timer[] = [];
let running = false;

/** Runs a sweep, catching everything so one bad cycle never kills the loop. */
async function guard(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const result = await fn();
    if (result && typeof result === "object") {
      const summary = Object.entries(result as Record<string, unknown>)
        .filter(([, v]) => typeof v === "number" && v !== 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      if (summary) console.log(`[${name}] ${summary}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${name}] failed: ${message}`);
    logEvent(`${name}.error`, message, { level: "error" });
  }
}

/**
 * Plans for any business whose calendar is running dry or whose last plan is
 * older than PLAN_INTERVAL_HOURS. Businesses are planned one at a time so a
 * burst of signups cannot fan out into concurrent model calls.
 */
export async function runPlanningSweep(now = new Date()): Promise<{
  planned: number;
  skipped: number;
}> {
  let planned = 0;
  let skipped = 0;

  for (const business of listBusinesses()) {
    if (business.autopilot !== 1) {
      skipped += 1;
      continue;
    }

    const last = lastPlanRun(business.id);
    if (last?.status === "running") {
      skipped += 1;
      continue;
    }

    const dueByTime =
      !last ||
      now.getTime() - new Date(last.started_at).getTime() >=
        config.planIntervalHours * 3600_000;

    // Also replan early if the business is about to run out of content.
    const upcoming = listContentItems(business.id, {
      status: "scheduled",
      limit: 500,
    }).filter((i) => new Date(i.scheduled_at).getTime() > now.getTime());
    const dueByEmpty = upcoming.length < 3;

    if (!dueByTime && !dueByEmpty) {
      skipped += 1;
      continue;
    }

    try {
      const result = await planCampaign(business, { from: now });
      planned += 1;
      console.log(
        `[plan] ${business.name}: ${result.itemsCreated} items` +
          (result.skipped.length > 0
            ? ` (${result.skipped.reduce((a, s) => a + s.count, 0)} rejected)`
            : ""),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plan] ${business.name} failed: ${message}`);
    }
  }

  return { planned, skipped };
}

/** Re-crawls any site whose content has not been read for a while. */
export async function runCrawlSweep(now = new Date()): Promise<{
  crawled: number;
  skipped: number;
}> {
  let crawled = 0;
  let skipped = 0;

  for (const site of listWebsites()) {
    const due =
      site.last_crawled_at === null ||
      now.getTime() - new Date(site.last_crawled_at).getTime() >=
        config.crawlIntervalHours * 3600_000;
    if (!due) {
      skipped += 1;
      continue;
    }
    try {
      const result = await crawlWebsite(site);
      crawled += 1;
      console.log(`[crawl] ${site.url}: ${result.pagesCrawled} pages`);
    } catch (err) {
      console.error(
        `[crawl] ${site.url} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { crawled, skipped };
}

export function startScheduler(): void {
  if (running) return;
  running = true;

  const publishEvery = config.publishIntervalMinutes * MINUTE;
  const metricsEvery = config.metricsIntervalMinutes * MINUTE;
  // Check whether planning is due four times per interval, so a business that
  // empties its calendar early is picked up promptly.
  const planCheckEvery = Math.max(
    15 * MINUTE,
    (config.planIntervalHours * 3600_000) / 4,
  );

  const monitorEvery = config.monitorIntervalMinutes * MINUTE;
  const crawlCheckEvery = Math.max(
    30 * MINUTE,
    (config.crawlIntervalHours * 3600_000) / 4,
  );

  timers = [
    setInterval(() => void guard("publish", runPublishSweep), publishEvery),
    setInterval(() => void guard("metrics", runMetricsSweep), metricsEvery),
    setInterval(() => void guard("plan", runPlanningSweep), planCheckEvery),
    setInterval(() => void guard("monitor", runMonitorSweep), monitorEvery),
    setInterval(() => void guard("crawl", runCrawlSweep), crawlCheckEvery),
  ];

  // Unref so the timers never hold the process open on their own.
  for (const t of timers) t.unref?.();

  console.log(
    `[scheduler] publish every ${config.publishIntervalMinutes}m, ` +
      `metrics every ${config.metricsIntervalMinutes}m, ` +
      `site checks every ${config.monitorIntervalMinutes}m, ` +
      `plan check every ${Math.round(planCheckEvery / MINUTE)}m`,
  );

  // Do a first pass straight away rather than waiting out the first interval.
  void guard("publish", runPublishSweep);
  void guard("monitor", runMonitorSweep);
}

export function stopScheduler(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
  running = false;
}
