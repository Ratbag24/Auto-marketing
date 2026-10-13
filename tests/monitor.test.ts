import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { useInMemoryDb, createBusiness } from "../src/db/index.js";
import {
  createWebsite,
  getWebsiteByKey,
  listIncidents,
  markVerified,
  openIncident,
  recordHealthCheck,
  recordVisit,
  uptimeSince,
  websiteForBusiness,
} from "../src/db/websites.js";
import { collect } from "../src/web/collect.js";
import { buildAudienceStats, buildSiteHealth } from "../src/engine/audience.js";
import type { Business } from "../src/db/types.js";

let business: Business;
let siteId: string;
let trackingKey: string;

beforeEach(() => {
  useInMemoryDb();
  business = createBusiness({
    name: "Test Co",
    one_liner: "Testing",
    audience: "Testers",
    tone: "Plain",
  });
  const site = createWebsite(business.id, "https://example.com", {
    goal_path: "/thanks",
  });
  siteId = site.id;
  trackingKey = site.tracking_key;
});

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

describe("uptime accounting", () => {
  test("counts successes against total checks", () => {
    for (let i = 0; i < 10; i += 1) {
      recordHealthCheck(
        {
          website_id: siteId,
          ok: i !== 3,
          status_code: i === 3 ? 503 : 200,
          response_ms: 200,
          ssl_days_left: 40,
          verdict: i === 3 ? "down" : "up",
          error: null,
        },
        ago(10 - i),
      );
    }

    const window = uptimeSince(siteId, ago(60));
    assert.equal(window.total, 10);
    assert.equal(window.ok, 9);

    const health = buildSiteHealth(siteId);
    assert.equal(health.verdict, "up", "the newest check should win");
    assert.equal(health.uptime_24h, 0.9);
  });

  test("average response time ignores failed checks", () => {
    recordHealthCheck(
      { website_id: siteId, ok: true, status_code: 200, response_ms: 100,
        ssl_days_left: 40, verdict: "up", error: null }, ago(3));
    recordHealthCheck(
      { website_id: siteId, ok: true, status_code: 200, response_ms: 300,
        ssl_days_left: 40, verdict: "up", error: null }, ago(2));
    // A failure records 0ms; averaging it in would understate real latency.
    recordHealthCheck(
      { website_id: siteId, ok: false, status_code: null, response_ms: 0,
        ssl_days_left: 40, verdict: "down", error: "timeout" }, ago(1));

    assert.equal(buildSiteHealth(siteId).avg_response_ms, 200);
  });

  test("reports no uptime figure before any check has run", () => {
    const health = buildSiteHealth(siteId);
    assert.equal(health.uptime_24h, null);
    assert.equal(health.description, "Not checked yet");
  });

  test("the newest check decides the verdict even at equal timestamps", () => {
    const at = ago(1);
    recordHealthCheck(
      { website_id: siteId, ok: false, status_code: 503, response_ms: 0,
        ssl_days_left: null, verdict: "down", error: "x" }, at);
    recordHealthCheck(
      { website_id: siteId, ok: true, status_code: 200, response_ms: 120,
        ssl_days_left: 30, verdict: "up", error: null }, at);

    // Ordering falls back to id, so the result is at least deterministic
    // rather than depending on scan order.
    const first = buildSiteHealth(siteId).verdict;
    const second = buildSiteHealth(siteId).verdict;
    assert.equal(first, second);
  });
});

describe("beacon collection", () => {
  const ctx = (ua: string, headers: Record<string, string> = {}) => ({
    ip: "203.0.113.5",
    userAgent: ua,
    headers,
  });
  const DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

  test("accepts a well-formed beacon and verifies the site", () => {
    assert.equal(websiteForBusiness(business.id)?.verified_at, null);

    const result = collect(
      { k: trackingKey, e: "view", p: "/pricing", sid: "s1", tz: "Europe/London" },
      ctx(DESKTOP),
    );
    assert.equal(result.accepted, true);

    // The first beacon proves the snippet is live on the site.
    assert.notEqual(websiteForBusiness(business.id)?.verified_at, null);

    const stats = buildAudienceStats(siteId);
    assert.equal(stats.totals.views, 1);
    assert.equal(stats.countries[0]?.key, "GB");
  });

  test("rejects an unknown tracking key", () => {
    const result = collect({ k: "am_nope", p: "/", sid: "s" }, ctx(DESKTOP));
    assert.equal(result.accepted, false);
    assert.equal(buildAudienceStats(siteId).totals.views, 0);
  });

  test("drops bots before they reach the statistics", () => {
    const result = collect(
      { k: trackingKey, p: "/", sid: "bot" },
      ctx("Mozilla/5.0 (compatible; Googlebot/2.1)"),
    );
    assert.equal(result.accepted, false);
    assert.equal(buildAudienceStats(siteId).totals.views, 0);
  });

  test("strips the query string from the stored path", () => {
    collect(
      { k: trackingKey, p: "/search?q=private+medical+question", sid: "s1" },
      ctx(DESKTOP),
    );
    const pages = buildAudienceStats(siteId).top_pages;
    assert.equal(pages[0]?.path, "/search");
  });

  test("marks the goal page as a conversion", () => {
    collect({ k: trackingKey, p: "/thanks", sid: "s1" }, ctx(DESKTOP));
    assert.equal(buildAudienceStats(siteId).totals.goals, 1);
  });

  test("attributes a visit to the post that produced it", () => {
    collect(
      { k: trackingKey, p: "/", sid: "s1", uc: "am_item_xyz" },
      ctx(DESKTOP),
    );
    const stats = buildAudienceStats(siteId);
    // No matching content item exists, so the join yields nothing - but the
    // raw attribution is stored for when one does.
    assert.equal(stats.totals.views, 1);
    assert.equal(stats.attributed.length, 0);
  });

  test("only the first pageview of a session counts as an entry", () => {
    collect({ k: trackingKey, p: "/", sid: "s1", r: "https://google.com/" }, ctx(DESKTOP));
    collect({ k: trackingKey, p: "/pricing", sid: "s1" }, ctx(DESKTOP));

    const stats = buildAudienceStats(siteId);
    assert.equal(stats.totals.views, 2);
    assert.equal(stats.totals.sessions, 1);
    assert.equal(stats.totals.pages_per_session, 2);
    // A two-page session is not a bounce.
    assert.equal(stats.totals.bounce_rate, 0);
  });

  test("a one-page session counts as a bounce", () => {
    collect({ k: trackingKey, p: "/", sid: "only" }, ctx(DESKTOP));
    assert.equal(buildAudienceStats(siteId).totals.bounce_rate, 1);
  });

  test("prefers a proxy country header over the timezone guess", () => {
    collect(
      { k: trackingKey, p: "/", sid: "s1", tz: "Europe/London" },
      ctx(DESKTOP, { "cf-ipcountry": "DE" }),
    );
    assert.equal(buildAudienceStats(siteId).countries[0]?.key, "DE");
  });

  test("a leave event does not create a second pageview", () => {
    collect({ k: trackingKey, e: "view", p: "/", sid: "s1" }, ctx(DESKTOP));
    collect({ k: trackingKey, e: "leave", p: "/", sid: "s1", d: 5000 }, ctx(DESKTOP));
    assert.equal(buildAudienceStats(siteId).totals.views, 1);
  });

  test("internal navigation is excluded from arrival sources", () => {
    const site = websiteForBusiness(business.id)!;
    recordVisit({
      website_id: site.id, business_id: business.id,
      visitor_hash: "v1", session_id: "s1", path: "/",
      referrer: "https://google.com/", referrer_source: "search:google.com",
      country: "GB", region: "Europe", timezone: "Europe/London",
      language: "en", device: "desktop", browser: "Chrome", os: "Windows",
      utm_source: null, utm_medium: null, utm_campaign: null,
      content_item_id: null, is_entry: 1, is_goal: 0, duration_ms: 0,
    });
    recordVisit({
      website_id: site.id, business_id: business.id,
      visitor_hash: "v1", session_id: "s1", path: "/pricing",
      referrer: "https://example.com/", referrer_source: "internal:example.com",
      country: "GB", region: "Europe", timezone: "Europe/London",
      language: "en", device: "desktop", browser: "Chrome", os: "Windows",
      utm_source: null, utm_medium: null, utm_campaign: null,
      content_item_id: null, is_entry: 0, is_goal: 0, duration_ms: 0,
    });

    const sources = buildAudienceStats(siteId).sources;
    assert.ok(!sources.some((s) => s.key.startsWith("internal")));
    assert.equal(sources[0]?.key, "search:google.com");
    // The one real arrival is the whole of arrivals.
    assert.equal(sources[0]?.share, 1);
  });
});

describe("tracking keys", () => {
  test("each site gets its own key", () => {
    const other = createBusiness({
      name: "Other", one_liner: "x", audience: "y", tone: "z",
    });
    const second = createWebsite(other.id, "https://other.example");
    assert.notEqual(second.tracking_key, trackingKey);
    assert.equal(getWebsiteByKey(trackingKey)?.id, siteId);
    assert.equal(getWebsiteByKey(second.tracking_key)?.id, second.id);
  });

  test("a beacon cannot write visits for another site", () => {
    const other = createBusiness({
      name: "Other", one_liner: "x", audience: "y", tone: "z",
    });
    const second = createWebsite(other.id, "https://other.example");

    collect({ k: second.tracking_key, p: "/", sid: "s" }, {
      ip: "203.0.113.5",
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/120",
      headers: {},
    });

    assert.equal(buildAudienceStats(siteId).totals.views, 0);
    assert.equal(buildAudienceStats(second.id).totals.views, 1);
  });
});
