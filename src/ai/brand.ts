import { getAiClient, type AiClient } from "./client.js";
import { BrandProfileSchema } from "./schemas.js";
import { saveBrandProfile, logEvent } from "../db/index.js";
import type { Business, BrandProfile } from "../db/types.js";

const SYSTEM = `You are a senior brand strategist. You turn a thin business \
brief into a rigorous, reusable brand profile that a marketing engine will \
use to generate months of content without further human input.

Hold to these standards:
- Be specific. "High quality service" is worthless; "same-day turnaround on \
quotes, which competitors take a week to return" is useful.
- Infer sensibly from the industry, but never invent facts a customer could \
check: no made-up awards, client names, statistics, prices or guarantees.
- Content pillars must be distinct from each other and sustainable for months.
- The 'avoid' list is where you prevent the engine embarrassing this brand. \
Include the generic marketing cliches that would make this specific business \
sound like everyone else, plus any claims it is not entitled to make.`;

export async function generateBrandProfile(
  business: Business,
  client: AiClient = getAiClient(),
): Promise<BrandProfile> {
  const prompt = `Build the brand profile for this business.

Business name: ${business.name}
What they sell: ${business.one_liner}
Who they sell to: ${business.audience}
Desired tone: ${business.tone}
Website: ${business.website ?? "(not provided)"}

Return the complete profile.`;

  const { value, usage } = await client.generate({
    schema: BrandProfileSchema,
    system: SYSTEM,
    prompt,
    effort: "high",
  });

  const saved = saveBrandProfile(business.id, {
    positioning: value.positioning,
    value_props: value.value_props,
    segments: value.segments,
    pillars: value.pillars,
    voice: value.voice,
  });

  logEvent("brand.generated", `Brand profile v${saved.version} generated`, {
    businessId: business.id,
    data: {
      pillars: value.pillars.map((p) => p.name),
      usage,
    },
  });

  return saved;
}
