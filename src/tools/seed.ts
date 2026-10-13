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
  listContentItems,
  logEvent,
  recordMetrics,
} from "../db/index.js";
import { runPublishSweep } from "../engine/publisher.js";
import { simulateMetrics } from "../channels/simulate.js";
import { CampaignPlanSchema, BrandProfileSchema } from "../ai/schemas.js";

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

  logEvent("system.seeded", "Demo data seeded", { businessId: business.id });

  console.log(`Seeded ${business.name} (${business.id})`);
  console.log(`  planned:   ${plan.itemsCreated} items`);
  console.log(`  published: ${publish.published + publish.simulated} (all simulated)`);
  console.log(`  measured:  ${measured} items, with daily history`);
  console.log(`\nStart the server with: npm start`);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
