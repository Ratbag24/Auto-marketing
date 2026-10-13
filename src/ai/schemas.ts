import { z } from "zod";

/**
 * Schemas for every structured model response. These are enforced server-side
 * via `output_config.format`, so a planning run either yields valid, typed
 * content or fails loudly - it can never half-write a campaign.
 */

export const SegmentSchema = z.object({
  name: z.string().describe("Short label for this audience segment"),
  pains: z.array(z.string()).describe("Concrete problems this segment feels"),
  hooks: z
    .array(z.string())
    .describe("Angles that earn this segment's attention"),
});

export const PillarSchema = z.object({
  name: z.string().describe("Content pillar name, 1-4 words"),
  description: z
    .string()
    .describe("What this pillar covers and why it moves this audience"),
});

export const BrandProfileSchema = z.object({
  positioning: z
    .string()
    .describe(
      "One paragraph: what this business is, for whom, and why it is the " +
        "obvious choice over alternatives",
    ),
  value_props: z
    .array(z.string())
    .describe("3-6 specific, non-generic reasons to buy"),
  segments: z
    .array(SegmentSchema)
    .describe("2-4 distinct audience segments worth addressing separately"),
  pillars: z
    .array(PillarSchema)
    .describe("4-6 recurring content themes to rotate through"),
  voice: z.object({
    guidelines: z
      .array(z.string())
      .describe("Concrete rules for how this brand writes"),
    avoid: z
      .array(z.string())
      .describe("Words, claims and habits this brand must never use"),
  }),
});

export type BrandProfileOutput = z.infer<typeof BrandProfileSchema>;

export const CHANNEL_ENUM = z.enum([
  "email",
  "x",
  "linkedin",
  "facebook",
  "instagram",
]);

export const PlannedItemSchema = z.object({
  channel: CHANNEL_ENUM.describe("Which channel this piece is written for"),
  pillar: z.string().describe("Which content pillar this piece serves"),
  subject: z
    .string()
    .describe(
      "Email subject line. Required for channel 'email'; empty string otherwise",
    ),
  body: z
    .string()
    .describe(
      "The finished copy, ready to publish as-is, written natively for the " +
        "channel and within its length limit",
    ),
  hashtags: z
    .array(z.string())
    .describe("Hashtags without the # prefix. Empty for email"),
  cta: z.string().describe("The single action this piece asks for"),
  day_offset: z
    .number()
    .int()
    .min(0)
    .max(27)
    .describe("Days from the start of the window on which to publish"),
  hour_local: z
    .number()
    .int()
    .min(0)
    .max(23)
    .describe(
      "Hour of day to publish, in the business's own local time - not UTC. " +
        "9 means 9am where the audience is.",
    ),
  rationale: z
    .string()
    .describe("One sentence: why this piece, this channel, this slot"),
});

export type PlannedItem = z.infer<typeof PlannedItemSchema>;

export const CampaignPlanSchema = z.object({
  strategy_note: z
    .string()
    .describe(
      "2-4 sentences for the operator: what this cycle is betting on, what " +
        "changed since last cycle, and what it is testing",
    ),
  items: z.array(PlannedItemSchema).describe("The content calendar"),
});

export type CampaignPlan = z.infer<typeof CampaignPlanSchema>;
