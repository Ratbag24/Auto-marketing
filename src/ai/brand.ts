import { getAiClient, type AiClient } from "./client.js";
import { BrandProfileSchema } from "./schemas.js";
import { saveBrandProfile, logEvent } from "../db/index.js";
import { listPages, websiteForBusiness } from "../db/websites.js";
import type { Business, BrandProfile } from "../db/types.js";

/**
 * Summarises what the crawler read from the business's own site.
 *
 * This is the single biggest quality lever in the whole product: a brand
 * profile built from the real site beats one inferred from a one-line
 * description, and it costs the business nothing extra to provide.
 */
function siteEvidence(businessId: string): string {
  const site = websiteForBusiness(businessId);
  if (!site) return "";

  const pages = listPages(site.id, 25).filter((p) => p.word_count > 40);
  if (pages.length === 0) return "";

  const lines = pages.slice(0, 12).map((page) => {
    const parts = [`- ${page.path}`];
    if (page.title) parts.push(`  title: ${page.title}`);
    if (page.meta_description) parts.push(`  description: ${page.meta_description}`);
    if (page.h1 && page.h1 !== page.title) parts.push(`  heading: ${page.h1}`);
    if (page.excerpt) parts.push(`  text: ${page.excerpt.slice(0, 320)}`);
    return parts.join("\n");
  });

  return `

THEIR ACTUAL WEBSITE
These pages were read from the business's own site. Treat them as the most
reliable description of what this business really offers, and prefer them over
inference wherever they conflict with the brief above. Specific services,
guarantees and details stated here are facts you may use; anything not stated
here or in the brief is not.

${lines.join("\n")}`;
}

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
Website: ${business.website ?? "(not provided)"}${siteEvidence(business.id)}

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

  const usedSite = siteEvidence(business.id) !== "";
  logEvent(
    "brand.generated",
    `Brand profile v${saved.version} generated` +
      (usedSite ? " from the live website" : " from the brief alone"),
    {
      businessId: business.id,
      data: {
        pillars: value.pillars.map((p) => p.name),
        used_site_content: usedSite,
        usage,
      },
    },
  );

  return saved;
}
