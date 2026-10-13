import { config } from "../config.js";
import type { Channel, ContentItem } from "../db/types.js";
import { simulateMetrics, simulatedExternalId } from "./simulate.js";
import {
  ChannelError,
  composeSocialText,
  type ChannelAdapter,
  type FetchedMetrics,
  type PublishResult,
} from "./types.js";

/**
 * LinkedIn organisation posting via the REST Posts API.
 *
 * Requires Community Management API access, which is partner-approved - the
 * slowest gate of the four channels. Until it is granted this adapter
 * simulates.
 */
export class LinkedInAdapter implements ChannelAdapter {
  readonly channel: Channel = "linkedin";

  isConfigured(): boolean {
    const c = config.channels.linkedin;
    return Boolean(c.accessToken && c.orgUrn && !c.orgUrn.endsWith("000000"));
  }

  configHint(): string {
    return this.isConfigured()
      ? "Ready."
      : "Set LINKEDIN_ACCESS_TOKEN and LINKEDIN_ORG_URN. Requires " +
          "Community Management API partner approval.";
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${config.channels.linkedin.accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      // LinkedIn requires an explicit API version header, YYYYMM.
      "LinkedIn-Version": "202601",
    };
  }

  async publish(item: ContentItem): Promise<PublishResult> {
    if (!this.isConfigured()) {
      return { externalId: simulatedExternalId(item), delivery: "simulated" };
    }

    const res = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        author: config.channels.linkedin.orgUrn,
        commentary: composeSocialText(item),
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ChannelError(
        `LinkedIn post failed (${res.status}): ${detail.slice(0, 300)}`,
        res.status === 429 || res.status >= 500,
      );
    }

    // The post URN comes back in a header, not the body.
    const urn = res.headers.get("x-restli-id") ?? res.headers.get("x-linkedin-id");
    if (!urn) {
      throw new ChannelError("LinkedIn returned no post URN.", false);
    }
    return { externalId: urn, delivery: "live" };
  }

  async fetchMetrics(item: ContentItem): Promise<FetchedMetrics> {
    if (!this.isConfigured() || item.delivery === "simulated") {
      return simulateMetrics(item);
    }
    if (!item.external_id) {
      throw new ChannelError("Cannot fetch metrics without a post URN.", false);
    }

    const params = new URLSearchParams({
      q: "organizationalEntity",
      organizationalEntity: config.channels.linkedin.orgUrn,
      "shares[0]": item.external_id,
    });
    const res = await fetch(
      `https://api.linkedin.com/rest/organizationalEntityShareStatistics?${params}`,
      { headers: this.headers() },
    );

    if (!res.ok) {
      throw new ChannelError(
        `LinkedIn metrics fetch failed (${res.status}).`,
        res.status === 429 || res.status >= 500,
      );
    }

    const data = (await res.json()) as {
      elements?: {
        totalShareStatistics?: {
          impressionCount?: number;
          clickCount?: number;
          likeCount?: number;
          shareCount?: number;
          commentCount?: number;
        };
      }[];
    };

    const s = data.elements?.[0]?.totalShareStatistics ?? {};
    return {
      impressions: s.impressionCount ?? 0,
      clicks: s.clickCount ?? 0,
      opens: 0,
      reactions: s.likeCount ?? 0,
      shares: s.shareCount ?? 0,
      comments: s.commentCount ?? 0,
      conversions: 0,
      simulated: false,
    };
  }
}
