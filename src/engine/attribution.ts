import { campaignTag } from "../web/analytics.js";
import type { ContentItem } from "../db/types.js";
import type { Website } from "../db/websites.js";

/**
 * Rewrites links to the business's own site so a visit can be traced back to
 * the exact post that produced it.
 *
 * Only the business's own origin is touched. Links to anywhere else are left
 * exactly as written - tagging a third party's URL would be both rude and
 * useless.
 */
export function tagLinks(body: string, item: ContentItem, site: Website): string {
  let origin: string;
  try {
    origin = new URL(site.url).origin;
  } catch {
    return body;
  }

  const host = origin.replace(/^https?:\/\//, "").replace(/^www\./, "");
  // Matches bare and full URLs for this host, stopping at whitespace or the
  // trailing punctuation that usually ends a sentence.
  const pattern = new RegExp(
    `(https?://)?(www\\.)?${host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\s<>"')\\]]*)`,
    "gi",
  );

  return body.replace(pattern, (match) => {
    // Don't double-tag something that already carries our campaign parameter.
    if (match.includes("utm_campaign=")) return match;

    const trailing = /[.,!?;:]$/.exec(match)?.[0] ?? "";
    const core = trailing ? match.slice(0, -trailing.length) : match;

    let url: URL;
    try {
      url = new URL(core.startsWith("http") ? core : `https://${core}`);
    } catch {
      return match;
    }

    url.searchParams.set("utm_source", channelToSource(item.channel));
    url.searchParams.set("utm_medium", "social");
    url.searchParams.set("utm_campaign", campaignTag(item.id));

    return `${url.toString()}${trailing}`;
  });
}

function channelToSource(channel: string): string {
  switch (channel) {
    case "x":
      return "x";
    case "linkedin":
      return "linkedin";
    case "facebook":
      return "facebook";
    case "instagram":
      return "instagram";
    case "email":
      return "email";
    default:
      return channel;
  }
}
