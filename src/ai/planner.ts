import { getAiClient, type AiClient } from "./client.js";
import { CampaignPlanSchema, type PlannedItem } from "./schemas.js";
import { CHANNEL_LIMITS } from "../channels/types.js";
import {
  buildPerformanceReport,
  renderPerformanceBrief,
} from "../engine/optimizer.js";
import {
  createContentItem,
  enabledChannels,
  finishPlanRun,
  getBrandProfile,
  logEvent,
  startPlanRun,
} from "../db/index.js";
import type { BrandProfile, Business, Channel } from "../db/types.js";
import { safeTimeZone, scheduleAt } from "../util/timezone.js";

export interface PlanOptions {
  /** Length of the calendar to produce. */
  windowDays?: number;
  /** Start of the window; defaults to now. */
  from?: Date;
  client?: AiClient;
}

export interface PlanResult {
  planRunId: string;
  itemsCreated: number;
  strategyNote: string;
  skipped: { reason: string; count: number }[];
}

/**
 * The stable half of the prompt. Identical for every run for a given business,
 * so it sits behind a cache breakpoint and costs ~10% after the first call.
 */
function buildSystemPrompt(
  business: Business,
  brand: BrandProfile,
  channels: Channel[],
): string {
  const limits = channels
    .map((c) => {
      const l = CHANNEL_LIMITS[c];
      return `  ${c}: max ${l.maxBodyChars} chars${
        l.maxHashtags > 0 ? `, up to ${l.maxHashtags} hashtags` : ", no hashtags"
      }${l.needsSubject ? ", requires a subject line" : ""}`;
    })
    .join("\n");

  return `You are the campaign planner for an autonomous marketing engine. \
You write finished, publishable copy - not drafts, not placeholders, not \
instructions for a human to complete. Anything you return goes out to a real \
audience, unedited.

BUSINESS
Name: ${business.name}
Sells: ${business.one_liner}
Audience: ${business.audience}
Tone: ${business.tone}
Website: ${business.website ?? "(none)"}
Local timezone: ${safeTimeZone(business.timezone)}

POSITIONING
${brand.positioning}

VALUE PROPOSITIONS
${brand.value_props.map((v) => `- ${v}`).join("\n")}

AUDIENCE SEGMENTS
${brand.segments
  .map(
    (s) =>
      `- ${s.name}\n    pains: ${s.pains.join("; ")}\n    hooks: ${s.hooks.join("; ")}`,
  )
  .join("\n")}

CONTENT PILLARS (use these exact names in the 'pillar' field)
${brand.pillars.map((p) => `- ${p.name}: ${p.description}`).join("\n")}

VOICE
Follow: ${brand.voice.guidelines.join("; ")}
Never: ${brand.voice.avoid.join("; ")}

CHANNELS AVAILABLE AND THEIR LIMITS
${limits}

HARD RULES
1. Stay inside each channel's character limit. Copy that exceeds it is discarded.
2. Write natively per channel. An email is not a tweet with more words; a \
LinkedIn post is not an Instagram caption.
3. Never invent verifiable facts: no statistics, prices, dates, awards, \
customer names, testimonials or guarantees that were not given to you above. \
Write persuasively from what you know.
4. Never promise what the business has not said it offers.
5. No placeholder text of any kind. No "[insert link]", no "XX% off", no \
"Lorem ipsum". If you need a destination, refer to the website generically.
6. Every piece needs exactly one call to action.
7. Vary structure and opening lines across the calendar. Repetition across a \
month reads as automation and kills engagement.
8. 'subject' is required for email and must be an empty string for every \
other channel. 'hashtags' must be empty for email.
9. 'hour_local' is the hour where this audience lives, not UTC. Pick hours a \
real person in ${safeTimeZone(business.timezone)} would be awake and reachable. \
Never schedule between 23:00 and 06:00 local unless the audience is \
specifically nocturnal.`;
}

function buildUserPrompt(
  business: Business,
  channels: Channel[],
  windowDays: number,
  targetCount: number,
  performanceBrief: string,
): string {
  return `Plan the next ${windowDays} days of marketing for ${business.name}.

Produce approximately ${targetCount} content items spread across these \
channels: ${channels.join(", ")}.

Spread them sensibly across the window using day_offset (0 to ${windowDays - 1}) \
and hour_local. Do not bunch several posts into the same hour. Respect normal \
expectations for cadence: email is the most intrusive channel and should be \
the least frequent.

${performanceBrief}

Return the strategy note and the full calendar.`;
}

/** Drops anything that would violate a channel's hard constraints. */
export function validatePlannedItem(
  item: PlannedItem,
  allowed: Channel[],
  pillarNames: string[],
): { ok: true } | { ok: false; reason: string } {
  if (!allowed.includes(item.channel)) {
    return { ok: false, reason: `channel ${item.channel} not enabled` };
  }
  const limits = CHANNEL_LIMITS[item.channel];
  const body = item.body.trim();
  if (body.length === 0) {
    return { ok: false, reason: "empty body" };
  }
  if (body.length > limits.maxBodyChars) {
    return {
      ok: false,
      reason: `body ${body.length} chars exceeds ${item.channel} limit of ${limits.maxBodyChars}`,
    };
  }
  if (limits.needsSubject && item.subject.trim().length === 0) {
    return { ok: false, reason: `${item.channel} requires a subject line` };
  }
  if (item.hashtags.length > limits.maxHashtags) {
    return {
      ok: false,
      reason: `${item.hashtags.length} hashtags exceeds ${item.channel} limit of ${limits.maxHashtags}`,
    };
  }
  // Catch the placeholder text that most often slips through.
  if (/\[(insert|your|add|link|name|xx)[^\]]*\]|lorem ipsum|\bXX%/i.test(body)) {
    return { ok: false, reason: "body contains placeholder text" };
  }
  if (pillarNames.length > 0 && !pillarNames.includes(item.pillar)) {
    return { ok: false, reason: `unknown pillar "${item.pillar}"` };
  }
  return { ok: true };
}

export async function planCampaign(
  business: Business,
  opts: PlanOptions = {},
): Promise<PlanResult> {
  const client = opts.client ?? getAiClient();
  const windowDays = opts.windowDays ?? 14;
  const from = opts.from ?? new Date();

  const brand = getBrandProfile(business.id);
  if (!brand) {
    throw new Error(
      `${business.name} has no brand profile yet - run onboarding first.`,
    );
  }

  const channels = enabledChannels(business.id);
  if (channels.length === 0) {
    throw new Error(`${business.name} has no channels enabled.`);
  }

  const run = startPlanRun(business.id);
  const targetCount = Math.max(
    1,
    Math.round((business.weekly_volume * windowDays) / 7),
  );

  try {
    const report = buildPerformanceReport(business.id);
    const { value: plan, usage } = await client.generate({
      schema: CampaignPlanSchema,
      system: buildSystemPrompt(business, brand, channels),
      prompt: buildUserPrompt(
        business,
        channels,
        windowDays,
        targetCount,
        renderPerformanceBrief(report),
      ),
      maxTokens: 16000,
    });

    const pillarNames = brand.pillars.map((p) => p.name);
    const heldForReview = business.approval_mode === "review";
    const skipReasons = new Map<string, number>();
    let created = 0;

    for (const item of plan.items) {
      const check = validatePlannedItem(item, channels, pillarNames);
      if (!check.ok) {
        skipReasons.set(check.reason, (skipReasons.get(check.reason) ?? 0) + 1);
        continue;
      }

      // The model picked a wall-clock hour in the business's own zone; this is
      // where that becomes a real instant, daylight saving included.
      const scheduledAt = scheduleAt(
        from,
        item.day_offset,
        item.hour_local,
        business.timezone,
      );
      // A slot that has already passed goes out on the next sweep rather than
      // being silently dropped.
      const when =
        scheduledAt.getTime() < from.getTime() ? from : scheduledAt;

      createContentItem({
        business_id: business.id,
        plan_run_id: run.id,
        channel: item.channel,
        pillar: item.pillar,
        subject: item.channel === "email" ? item.subject : null,
        body: item.body.trim(),
        hashtags: item.hashtags,
        cta: item.cta,
        scheduled_at: when.toISOString(),
        status: heldForReview ? "draft" : "scheduled",
      });
      created += 1;
    }

    const skipped = [...skipReasons.entries()].map(([reason, count]) => ({
      reason,
      count,
    }));

    finishPlanRun(run.id, {
      status: "succeeded",
      items_created: created,
      strategy_note: plan.strategy_note,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cached_tokens: usage.cached_tokens,
    });

    logEvent(
      "plan.completed",
      `Planned ${created} items for the next ${windowDays} days` +
        (heldForReview ? " (held for review)" : ""),
      {
        businessId: business.id,
        level: skipped.length > 0 ? "warn" : "info",
        data: { created, skipped, usage, cold_start: report.cold_start },
      },
    );

    return {
      planRunId: run.id,
      itemsCreated: created,
      strategyNote: plan.strategy_note,
      skipped,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishPlanRun(run.id, { status: "failed", error: message });
    logEvent("plan.failed", `Planning failed: ${message}`, {
      businessId: business.id,
      level: "error",
    });
    throw err;
  }
}
