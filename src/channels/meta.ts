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

const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * Facebook Page posting via the Graph API.
 *
 * Requires a Page access token with pages_manage_posts, which means App Review
 * for anything beyond your own test app.
 */
export class FacebookAdapter implements ChannelAdapter {
  readonly channel: Channel = "facebook";

  isConfigured(): boolean {
    const c = config.channels.meta;
    return Boolean(c.accessToken && c.pageId);
  }

  configHint(): string {
    return this.isConfigured()
      ? "Ready."
      : "Set META_ACCESS_TOKEN and META_PAGE_ID. Requires Meta App Review " +
          "for pages_manage_posts.";
  }

  async publish(item: ContentItem): Promise<PublishResult> {
    if (!this.isConfigured()) {
      return { externalId: simulatedExternalId(item), delivery: "simulated" };
    }

    const res = await fetch(`${GRAPH}/${config.channels.meta.pageId}/feed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: composeSocialText(item),
        access_token: config.channels.meta.accessToken,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ChannelError(
        `Facebook post failed (${res.status}): ${detail.slice(0, 300)}`,
        res.status === 429 || res.status >= 500,
      );
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new ChannelError("Facebook returned no post id.", false);
    return { externalId: data.id, delivery: "live" };
  }

  async fetchMetrics(item: ContentItem): Promise<FetchedMetrics> {
    if (!this.isConfigured() || item.delivery === "simulated") {
      return simulateMetrics(item);
    }
    if (!item.external_id) {
      throw new ChannelError("Cannot fetch metrics without a post id.", false);
    }

    const params = new URLSearchParams({
      metric: "post_impressions,post_clicks,post_reactions_by_type_total",
      access_token: config.channels.meta.accessToken,
    });
    const res = await fetch(`${GRAPH}/${item.external_id}/insights?${params}`);
    if (!res.ok) {
      throw new ChannelError(
        `Facebook metrics fetch failed (${res.status}).`,
        res.status === 429 || res.status >= 500,
      );
    }

    const data = (await res.json()) as {
      data?: { name: string; values?: { value: unknown }[] }[];
    };

    const read = (name: string): number => {
      const v = data.data?.find((d) => d.name === name)?.values?.[0]?.value;
      if (typeof v === "number") return v;
      // post_reactions_by_type_total returns a map of reaction -> count.
      if (v && typeof v === "object") {
        return Object.values(v as Record<string, number>).reduce(
          (a, b) => a + (typeof b === "number" ? b : 0),
          0,
        );
      }
      return 0;
    };

    return {
      impressions: read("post_impressions"),
      clicks: read("post_clicks"),
      opens: 0,
      reactions: read("post_reactions_by_type_total"),
      shares: 0,
      comments: 0,
      conversions: 0,
      simulated: false,
    };
  }
}

/**
 * Instagram Business posting via the Graph API.
 *
 * Instagram requires an image or video for every feed post - there is no
 * text-only post. Until an image pipeline is wired in, this adapter reports
 * itself unconfigured and simulates, rather than failing at publish time.
 */
export class InstagramAdapter implements ChannelAdapter {
  readonly channel: Channel = "instagram";

  isConfigured(): boolean {
    // Deliberately false: see the class comment. Returning true here would
    // queue posts that can only ever fail.
    return false;
  }

  configHint(): string {
    const c = config.channels.meta;
    if (!c.accessToken || !c.igUserId) {
      return "Set META_ACCESS_TOKEN and META_IG_USER_ID. Requires Meta App Review.";
    }
    return (
      "Credentials present, but Instagram feed posts require an image or " +
      "video. Add media generation before enabling this channel."
    );
  }

  async publish(item: ContentItem): Promise<PublishResult> {
    return { externalId: simulatedExternalId(item), delivery: "simulated" };
  }

  async fetchMetrics(item: ContentItem): Promise<FetchedMetrics> {
    return simulateMetrics(item);
  }
}
