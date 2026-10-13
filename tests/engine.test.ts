import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createBusiness,
  createContentItem,
  dueContentItems,
  enableChannel,
  getContentItem,
  listContentItems,
  markPublishing,
  recordMetrics,
  saveBrandProfile,
  updateBusiness,
  useInMemoryDb,
} from "../src/db/index.js";
import { registerAdapter } from "../src/channels/registry.js";
import { ChannelError, type ChannelAdapter } from "../src/channels/types.js";
import { runPublishSweep } from "../src/engine/publisher.js";
import { runMetricsSweep } from "../src/engine/metrics.js";
import { buildPerformanceReport, renderPerformanceBrief } from "../src/engine/optimizer.js";
import { dailySeries } from "../src/engine/stats.js";
import type { Business, Channel, ContentItem } from "../src/db/types.js";

/** Records what it was asked to publish, and can be told to fail. */
class FakeAdapter implements ChannelAdapter {
  readonly channel: Channel;
  published: ContentItem[] = [];
  mode: "ok" | "retryable" | "permanent" = "ok";
  configured = true;

  constructor(channel: Channel) {
    this.channel = channel;
  }

  isConfigured() {
    return this.configured;
  }
  configHint() {
    return "fake";
  }
  async publish(item: ContentItem) {
    if (this.mode === "retryable") throw new ChannelError("rate limited", true);
    if (this.mode === "permanent") throw new ChannelError("bad request", false);
    this.published.push(item);
    return { externalId: `ext_${item.id}`, delivery: "live" as const };
  }
  async fetchMetrics() {
    return {
      impressions: 100,
      clicks: 5,
      opens: 0,
      reactions: 3,
      shares: 1,
      comments: 1,
      conversions: 2,
      simulated: false,
    };
  }
}

let fake: FakeAdapter;
let business: Business;

function makeBusiness(): Business {
  const b = createBusiness({
    name: "Test Co",
    one_liner: "Testing",
    audience: "Testers",
    tone: "Plain",
  });
  enableChannel(b.id, "x");
  saveBrandProfile(b.id, {
    positioning: "p",
    value_props: ["v"],
    segments: [],
    pillars: [{ name: "Access", description: "d" }],
    voice: { guidelines: [], avoid: [] },
  });
  return b;
}

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 86_400_000).toISOString();

beforeEach(() => {
  useInMemoryDb();
  fake = new FakeAdapter("x");
  registerAdapter(fake);
  business = makeBusiness();
});

describe("publish sweep gates", () => {
  test("publishes an item that is due", async () => {
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "hello",
      scheduled_at: past(),
    });

    const result = await runPublishSweep();
    assert.equal(result.published, 1);
    assert.equal(fake.published.length, 1);
  });

  test("leaves an item scheduled in the future alone", async () => {
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "later",
      scheduled_at: future(),
    });

    const result = await runPublishSweep();
    assert.equal(result.considered, 0);
    assert.equal(fake.published.length, 0);
  });

  // The review queue is the main brand-safety control: a draft must never be
  // picked up by the publisher, however overdue it is.
  test("never publishes a draft held for review", async () => {
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "unreviewed",
      scheduled_at: past(),
      status: "draft",
    });

    const result = await runPublishSweep();
    assert.equal(result.considered, 0);
    assert.equal(fake.published.length, 0);
  });

  test("skips a business whose autopilot is off", async () => {
    updateBusiness(business.id, { autopilot: 0 });
    const item = createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "paused",
      scheduled_at: past(),
    });

    const result = await runPublishSweep();
    assert.equal(result.skipped, 1);
    assert.equal(fake.published.length, 0);
    assert.equal(getContentItem(item.id)?.status, "skipped");
  });

  test("a claimed item cannot be claimed twice", () => {
    const item = createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "once",
      scheduled_at: past(),
    });

    assert.equal(markPublishing(item.id), true);
    assert.equal(markPublishing(item.id), false);
  });
});

describe("publish failures", () => {
  test("a retryable failure returns the item to the queue", async () => {
    fake.mode = "retryable";
    const item = createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "retry me",
      scheduled_at: past(),
    });

    await runPublishSweep();
    const after = getContentItem(item.id);
    assert.equal(after?.status, "scheduled");
    assert.equal(after?.attempts, 1);
    assert.match(after?.error ?? "", /rate limited/);
  });

  test("a permanent failure is not retried", async () => {
    fake.mode = "permanent";
    const item = createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "give up",
      scheduled_at: past(),
    });

    await runPublishSweep();
    assert.equal(getContentItem(item.id)?.status, "failed");
  });

  test("a retryable failure stops being retried after four attempts", async () => {
    fake.mode = "retryable";
    const item = createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "persistent",
      scheduled_at: past(),
    });

    for (let i = 0; i < 4; i += 1) await runPublishSweep();

    const after = getContentItem(item.id);
    assert.equal(after?.status, "failed");
    assert.equal(after?.attempts, 4);
  });
});

describe("metrics and optimisation", () => {
  test("records metrics for published items", async () => {
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "measured",
      scheduled_at: past(),
    });
    await runPublishSweep();

    const result = await runMetricsSweep();
    assert.equal(result.recorded, 1);

    const report = buildPerformanceReport(business.id);
    assert.equal(report.totals.impressions, 100);
    // clicks 5 + reactions 3 + shares 1 + comments 1
    assert.equal(report.totals.engagements, 10);
    assert.equal(report.totals.engagement_rate, 0.1);
  });

  test("uses only the latest metric row per item", async () => {
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "polled twice",
      scheduled_at: past(),
    });
    await runPublishSweep();
    await runMetricsSweep();
    await runMetricsSweep();

    const report = buildPerformanceReport(business.id);
    // Two sweeps, but impressions must not double-count.
    assert.equal(report.totals.impressions, 100);
    assert.equal(report.items_measured, 1);
  });

  test("reports cold start until there are enough measured posts", () => {
    const report = buildPerformanceReport(business.id);
    assert.equal(report.cold_start, true);
    assert.match(renderPerformanceBrief(report), /insufficient/);
  });

  test("the brief steers on evidence once past cold start", async () => {
    for (let i = 0; i < 9; i += 1) {
      createContentItem({
        business_id: business.id,
        channel: "x",
        pillar: i % 2 === 0 ? "Access" : "Prevention",
        body: `post ${i}`,
        scheduled_at: past(),
      });
    }
    await runPublishSweep();
    await runMetricsSweep();

    const report = buildPerformanceReport(business.id);
    assert.equal(report.cold_start, false);
    const brief = renderPerformanceBrief(report);
    assert.match(brief, /By channel/);
    assert.match(brief, /By content pillar/);
    // Must always reserve room for exploration, or the plan collapses.
    assert.match(brief, /exploring untested angles/);
  });

  test("flags simulated measurements in the brief", async () => {
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "sim",
      scheduled_at: past(),
    });
    await runPublishSweep();

    for (let i = 0; i < 9; i += 1) {
      const item = createContentItem({
        business_id: business.id,
        channel: "x",
        pillar: "Access",
        body: `sim ${i}`,
        scheduled_at: past(),
      });
      recordMetrics({
        content_item_id: item.id,
        business_id: business.id,
        channel: "x",
        impressions: 50,
        clicks: 1,
        opens: 0,
        reactions: 0,
        shares: 0,
        comments: 0,
        conversions: 0,
        simulated: 1,
      });
    }

    const report = buildPerformanceReport(business.id);
    assert.ok(report.simulated_share > 0);
    assert.match(renderPerformanceBrief(report), /simulation mode/);
  });
});

describe("daily series", () => {
  test("does not double-count repeated polls on the same day", async () => {
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "daily",
      scheduled_at: past(),
    });
    await runPublishSweep();
    await runMetricsSweep();
    await runMetricsSweep();
    await runMetricsSweep();

    const series = dailySeries(business.id);
    assert.equal(series.length, 1);
    assert.equal(series[0]?.impressions, 100);
  });
});

describe("due item selection", () => {
  test("only returns scheduled items at or before the cutoff", () => {
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "due",
      scheduled_at: past(),
    });
    createContentItem({
      business_id: business.id,
      channel: "x",
      pillar: "Access",
      body: "not due",
      scheduled_at: future(),
    });

    assert.equal(dueContentItems(10).length, 1);
    assert.equal(listContentItems(business.id).length, 2);
  });
});
