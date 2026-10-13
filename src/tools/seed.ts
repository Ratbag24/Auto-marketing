/**
 * Seeds a demo business with a stubbed brand profile, a two-week calendar and
 * simulated performance history, so the dashboard can be explored without an
 * API key or any channel credentials.
 *
 * Everything it creates is flagged as simulated.
 */
import { setAiClient, type AiClient } from "../ai/client.js";
import { planCampaign } from "../ai/planner.js";
import { generateBrandProfile } from "../ai/brand.js";
import {
  backdatePublishedAt,
  createBusiness,
  enableChannel,
  getDb,
  nowIso,
  listContentItems,
  logEvent,
  recordMetrics,
} from "../db/index.js";
import { runPublishSweep } from "../engine/publisher.js";
import { simulateMetrics } from "../channels/simulate.js";
import { CampaignPlanSchema, BrandProfileSchema } from "../ai/schemas.js";
import {
  createWebsite,
  markVerified,
  recordHealthCheck,
  recordVisit,
  savePage,
  startIncident,
  resolveIncident,
  touchCrawl,
  updateWebsite,
} from "../db/websites.js";
import { campaignTag } from "../web/analytics.js";

const DEMO_BRAND = {
  positioning:
    "Northgate Dental is a family practice in a commuter suburb that wins on " +
    "access: evening and Saturday appointments, same-week emergency slots, " +
    "and a fixed price list published up front.",
  value_props: [
    "Evening and Saturday appointments for people who cannot take time off work",
    "Same-week emergency slots held back every day",
    "Fixed, published prices with no quote required",
    "One dentist sees you every visit, not whoever is free",
  ],
  segments: [
    {
      name: "Time-poor commuters",
      pains: ["Cannot attend weekday daytime appointments", "Dread rescheduling"],
      hooks: ["Book an appointment that fits around work, not instead of it"],
    },
    {
      name: "Anxious avoiders",
      pains: ["Years since last visit", "Fear of judgement and surprise costs"],
      hooks: ["No lectures, no surprise bills, prices published before you sit down"],
    },
  ],
  pillars: [
    { name: "Access", description: "Appointment availability and convenience" },
    { name: "Price clarity", description: "What things cost and why" },
    { name: "Prevention", description: "Practical everyday dental care" },
    { name: "Reassurance", description: "Lowering the barrier for nervous patients" },
  ],
  voice: {
    guidelines: ["Plain English", "Warm but matter-of-fact", "Lead with the practical detail"],
    avoid: ["Clinical jargon", "Scare tactics", "Exclamation marks", "'State-of-the-art'"],
  },
};

const PILLARS = DEMO_BRAND.pillars.map((p) => p.name);
const CHANNELS = ["email", "x", "linkedin"] as const;

const COPY: Record<string, string[]> = {
  Access: [
    "Half our appointments start after 5pm. If the only reason you have put off a check-up is the working day, that reason is gone.",
    "We hold back emergency slots every single day. Toothache on a Tuesday morning usually means a Tuesday appointment.",
    "Saturday mornings are our busiest clinic. Not because we are short of weekday space, but because that is when people can actually come.",
  ],
  "Price clarity": [
    "Our full price list is on the website. Not a starting-from figure, not a range: the actual cost of the actual appointment.",
    "A check-up here costs the same whether you booked it today or three months ago. No dynamic pricing, no quote process.",
    "Nobody should need a consultation to find out what a filling costs. Ours are listed before you pick up the phone.",
  ],
  Prevention: [
    "Two minutes of brushing is longer than it feels. Most people stop at forty seconds. Time it once and you will see.",
    "Flossing before brushing, not after, means the fluoride reaches the gaps you have just cleared. Small change, real difference.",
    "The single best thing you can do for your teeth is to stop sipping sugary drinks across the whole day. Frequency beats quantity.",
  ],
  Reassurance: [
    "If it has been years, you are not unusual and you will not be told off. We start where you are.",
    "You can ask us to stop at any point. Say so, we stop. That is the whole arrangement.",
    "Nervous patients can book a first visit where nothing happens except a conversation. No instruments, no treatment.",
  ],
};

/** Stub model client: returns fixed, realistic content with zero token cost. */
const stubClient: AiClient = {
  async generate({ schema }) {
    const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
    // Widened so the concrete schemas can be compared against the generic T.
    const which = schema as unknown;

    if (which === BrandProfileSchema) {
      return { value: DEMO_BRAND as never, usage };
    }

    if (which === CampaignPlanSchema) {
      const items = [];
      for (let day = 0; day < 14; day += 1) {
        // Two pieces most days, email only twice across the fortnight.
        const slots = day % 7 === 2 ? ["email", "x"] : ["x", "linkedin"];
        for (const [idx, channel] of slots.entries()) {
          const pillar = PILLARS[(day + idx) % PILLARS.length]!;
          const options = COPY[pillar]!;
          const body = options[(day + idx) % options.length]!;
          items.push({
            channel: channel as (typeof CHANNELS)[number],
            pillar,
            subject:
              channel === "email" ? `${pillar}: what that means for your next visit` : "",
            body,
            hashtags: channel === "email" ? [] : ["dentistry", "northgate"],
            cta: "Book online in under a minute.",
            day_offset: day,
            hour_utc: idx === 0 ? 9 : 16,
            rationale: "Seeded demo content.",
          });
        }
      }
      return {
        value: {
          strategy_note:
            "Seeded demo cycle: even coverage across all four pillars and " +
            "three channels so the optimiser has balanced signal to learn from.",
          items,
        } as never,
        usage,
      };
    }

    throw new Error("Stub client received an unexpected schema");
  },
};

async function seed(): Promise<void> {
  getDb();
  setAiClient(stubClient);

  const business = createBusiness({
    name: "Northgate Dental",
    website: "https://example.com",
    one_liner: "A family dental practice with evening and weekend appointments",
    audience: "Working adults and families within 10 miles who struggle to attend weekday appointments",
    tone: "Warm, plain-spoken, practical",
    weekly_volume: 14,
  });
  for (const channel of CHANNELS) enableChannel(business.id, channel, "demo");

  await generateBrandProfile(business);

  // Backdate the window so most of the calendar is already "published" and
  // therefore has metrics to show.
  const from = new Date(Date.now() - 12 * 86_400_000);
  const plan = await planCampaign(business, { from, windowDays: 14 });

  const publish = await runPublishSweep();

  // The publish sweep stamps published_at as now, which is correct in real
  // operation but leaves the backdated demo posts looking zero-hours-old - and
  // simulated reach scales with time live, so every number would be zero.
  // Realign published_at with the intended slot, then build a day-by-day
  // metric series so the dashboard has a trend to draw.
  const published = listContentItems(business.id, { limit: 500 }).filter(
    (i) => i.status === "published",
  );

  let measured = 0;
  for (const item of published) {
    backdatePublishedAt(item.id, item.scheduled_at);
    const liveFrom = new Date(item.scheduled_at).getTime();

    // One capture per day from publication to now, so each post accumulates.
    for (let day = 0; ; day += 1) {
      const capturedAt = liveFrom + day * 86_400_000;
      if (capturedAt > Date.now()) break;
      const snapshot = simulateMetrics(
        { ...item, published_at: item.scheduled_at },
        new Date(capturedAt),
      );
      recordMetrics(
        {
          content_item_id: item.id,
          business_id: item.business_id,
          channel: item.channel,
          impressions: snapshot.impressions,
          clicks: snapshot.clicks,
          opens: snapshot.opens,
          reactions: snapshot.reactions,
          shares: snapshot.shares,
          comments: snapshot.comments,
          conversions: snapshot.conversions,
          simulated: 1,
        },
        new Date(capturedAt).toISOString(),
      );
    }
    measured += 1;
  }

  // ---- website: pages, health history and visitor traffic ----------------
  // All of it clearly synthetic, so the new panels have something to show
  // without pointing the crawler at a real site.
  const site = createWebsite(business.id, "https://northgate.example", {
    expected_text: "Book an appointment",
    goal_path: "/booking/confirmed",
  });
  markVerified(site.id);
  // northgate.example is not a real domain, so live checks would immediately
  // overwrite the synthetic history below with a genuine "unreachable".
  // Pause monitoring on the demo site; a real site you connect is monitored.
  updateWebsite(site.id, { monitor_enabled: 0 });

  const DEMO_PAGES = [
    { path: "/", title: "Northgate Dental — Evening and Saturday appointments",
      h1: "Dentistry that fits around work", words: 420, issues: [] },
    { path: "/prices", title: "Our prices", h1: "What treatment costs",
      words: 310, issues: [] },
    { path: "/book", title: "Book an appointment", h1: "Book online",
      words: 180, issues: ["No meta description"] },
    { path: "/emergency", title: "Emergency appointments", h1: "Same-week emergency slots",
      words: 240, issues: [] },
    { path: "/about", title: "About", h1: "About the practice",
      words: 95, issues: ["Very little text on the page", "2 images missing alt text"] },
    { path: "/nervous-patients", title: "Nervous patients", h1: "If you are nervous",
      words: 350, issues: ["3 images missing alt text"] },
  ];

  for (const page of DEMO_PAGES) {
    savePage({
      website_id: site.id,
      url: `https://northgate.example${page.path}`,
      path: page.path,
      title: page.title,
      meta_description: page.issues.includes("No meta description")
        ? null
        : `${page.title}. Northgate Dental.`,
      h1: page.h1,
      excerpt: `${page.h1}. Evening and Saturday appointments, fixed published prices.`,
      word_count: page.words,
      status_code: 200,
      internal_links: 6,
      external_links: 1,
      issues: page.issues,
    });
  }
  touchCrawl(site.id, nowIso());

  // Health history: mostly up, with one short outage two days ago.
  const CHECK_EVERY_MS = 30 * 60_000;
  const checksBack = 7 * 24 * 2; // a week at half-hourly
  const outageStart = Date.now() - 2 * 86_400_000;
  const outageEnd = outageStart + 70 * 60_000;
  let incidentId: string | null = null;

  for (let i = checksBack; i >= 0; i -= 1) {
    const at = Date.now() - i * CHECK_EVERY_MS;
    const inOutage = at >= outageStart && at <= outageEnd;
    const slow = !inOutage && Math.sin(i / 7) > 0.93;

    recordHealthCheck(
      {
        website_id: site.id,
        ok: !inOutage,
        status_code: inOutage ? 503 : 200,
        response_ms: inOutage ? 0 : slow ? 3400 + (i % 300) : 210 + (i % 180),
        ssl_days_left: 46,
        verdict: inOutage ? "down" : slow ? "slow" : "up",
        error: inOutage ? "Server error 503" : null,
      },
      new Date(at).toISOString(),
    );

    if (inOutage && incidentId === null) {
      incidentId = startIncident(
        site.id,
        "down",
        "Server error 503",
        new Date(at).toISOString(),
      ).id;
    }
    if (!inOutage && incidentId !== null) {
      resolveIncident(incidentId, new Date(at).toISOString());
      incidentId = null;
    }
  }

  // Visitor traffic: 30 days, weighted towards the UK, mostly mobile, with a
  // slice attributed to published posts.
  const COUNTRIES: [string, string, number][] = [
    ["GB", "Europe/London", 62],
    ["IE", "Europe/Dublin", 9],
    ["US", "America/New_York", 14],
    ["AU", "Australia/Sydney", 6],
    ["DE", "Europe/Berlin", 5],
    ["CA", "America/Toronto", 4],
  ];
  const SOURCES: [string, string | null][] = [
    ["direct", null],
    ["search:google.com", "https://www.google.com/"],
    ["social:linkedin.com", "https://linkedin.com/feed"],
    ["social:x.com", "https://x.com/"],
    ["referral:localdirectory.example", "https://localdirectory.example/dentists"],
  ];
  const PATHS = ["/", "/prices", "/book", "/emergency", "/about", "/nervous-patients"];
  const publishedIds = published.map((p) => p.id);

  let visitCount = 0;
  for (let day = 29; day >= 0; day -= 1) {
    const dayStart = Date.now() - day * 86_400_000;
    // Traffic grows slowly and dips at weekends.
    const weekday = new Date(dayStart).getUTCDay();
    const base = 26 + Math.round((29 - day) * 0.9);
    const sessions = Math.max(6, weekday === 0 || weekday === 6 ? base - 12 : base);

    for (let s = 0; s < sessions; s += 1) {
      const sessionId = `sess_${day}_${s}`;
      const pick = <T,>(arr: T[], seed: number) => arr[(day * 7 + s * 3 + seed) % arr.length]!;
      const [country, timezone] = (() => {
        let roll = (day * 13 + s * 7) % 100;
        for (const [c, tz, weight] of COUNTRIES) {
          if (roll < weight) return [c, tz];
          roll -= weight;
        }
        return ["GB", "Europe/London"];
      })();
      const [source, referrer] = pick(SOURCES, 1);
      const device = (day + s) % 10 < 6 ? "mobile" : (day + s) % 10 < 9 ? "desktop" : "tablet";

      // Posts bring a slice of the social traffic.
      const fromPost =
        source.startsWith("social") && publishedIds.length > 0 && (day + s) % 3 === 0;
      const contentItemId = fromPost ? pick(publishedIds, 2) : null;

      // One to three pages per session.
      const depth = 1 + ((day + s) % 3);
      for (let v = 0; v < depth; v += 1) {
        const path = v === 0 ? "/" : pick(PATHS, v + 4);
        recordVisit(
          {
            website_id: site.id,
            business_id: business.id,
            visitor_hash: `demo_${day}_${s % 40}`,
            session_id: sessionId,
            path,
            referrer: v === 0 ? referrer : `https://northgate.example/`,
            referrer_source: v === 0 ? source : "internal:northgate.example",
            country,
            region: timezone.split("/")[0] === "America" ? "Americas" : timezone.split("/")[0]!,
            timezone,
            language: country === "GB" ? "en-GB" : "en-US",
            device,
            browser: device === "mobile" ? "Safari" : "Chrome",
            os: device === "mobile" ? "iOS" : "Windows",
            utm_source: contentItemId ? source.split(":")[0]! : null,
            utm_medium: contentItemId ? "social" : null,
            utm_campaign: contentItemId ? campaignTag(contentItemId) : null,
            content_item_id: contentItemId,
            is_entry: v === 0 ? 1 : 0,
            // A small share of deep sessions reach the booking confirmation.
            is_goal: v === depth - 1 && depth === 3 && (day + s) % 4 === 0 ? 1 : 0,
            duration_ms: 20_000 + ((day * s) % 90) * 1000,
          },
          new Date(dayStart + (9 + (s % 12)) * 3600_000 + s * 37_000).toISOString(),
        );
        visitCount += 1;
      }
    }
  }

  logEvent("system.seeded", "Demo data seeded", { businessId: business.id });

  console.log(`Seeded ${business.name} (${business.id})`);
  console.log(`  planned:   ${plan.itemsCreated} items`);
  console.log(`  published: ${publish.published + publish.simulated} (all simulated)`);
  console.log(`  measured:  ${measured} items, with daily history`);
  console.log(`  website:   ${DEMO_PAGES.length} pages, ${checksBack + 1} health checks, ${visitCount} visits`);
  console.log(`             (monitoring paused - the demo domain is not real)`);
  console.log(`\nStart the server with: npm start`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
