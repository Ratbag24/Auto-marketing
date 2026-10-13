import { config } from "../config.js";
import type { Channel, ContentItem } from "../db/types.js";
import { buildAuthHeader, type OAuth1Credentials } from "./oauth1.js";
import { simulateMetrics, simulatedExternalId } from "./simulate.js";
import {
  ChannelError,
  composeSocialText,
  type ChannelAdapter,
  type FetchedMetrics,
  type PublishResult,
} from "./types.js";

const POST_URL = "https://api.x.com/2/tweets";

/**
 * X / Twitter via API v2.
 *
 * Posting requires a paid API tier (Basic or above as of 2026) plus OAuth 1.0a
 * user-context credentials. Organic post metrics need the `tweet.read` and
 * `users.read` scopes and are only available for your own posts.
 */
export class XAdapter implements ChannelAdapter {
  readonly channel: Channel = "x";

  private creds(): OAuth1Credentials {
    const c = config.channels.x;
    return {
      apiKey: c.apiKey,
      apiSecret: c.apiSecret,
      accessToken: c.accessToken,
      accessSecret: c.accessSecret,
    };
  }

  isConfigured(): boolean {
    const c = this.creds();
    return Boolean(c.apiKey && c.apiSecret && c.accessToken && c.accessSecret);
  }

  configHint(): string {
    return this.isConfigured()
      ? "Ready."
      : "Set X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN and X_ACCESS_SECRET. " +
          "Posting requires a paid X API tier.";
  }

  async publish(item: ContentItem): Promise<PublishResult> {
    if (!this.isConfigured()) {
      return { externalId: simulatedExternalId(item), delivery: "simulated" };
    }

    const text = composeSocialText(item);
    const res = await fetch(POST_URL, {
      method: "POST",
      headers: {
        Authorization: buildAuthHeader("POST", POST_URL, this.creds()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ChannelError(
        `X post failed (${res.status}): ${detail.slice(0, 300)}`,
        res.status === 429 || res.status >= 500,
      );
    }

    const data = (await res.json()) as { data?: { id?: string } };
    if (!data.data?.id) {
      throw new ChannelError("X returned no post id.", false);
    }
    return { externalId: data.data.id, delivery: "live" };
  }

  async fetchMetrics(item: ContentItem): Promise<FetchedMetrics> {
    if (!this.isConfigured() || item.delivery === "simulated") {
      return simulateMetrics(item);
    }
    if (!item.external_id) {
      throw new ChannelError("Cannot fetch metrics without a post id.", false);
    }

    const url = `https://api.x.com/2/tweets/${item.external_id}`;
    const query = { "tweet.fields": "public_metrics,non_public_metrics" };
    const res = await fetch(`${url}?${new URLSearchParams(query)}`, {
      headers: {
        Authorization: buildAuthHeader("GET", url, this.creds(), query),
      },
    });

    if (!res.ok) {
      throw new ChannelError(
        `X metrics fetch failed (${res.status}).`,
        res.status === 429 || res.status >= 500,
      );
    }

    const data = (await res.json()) as {
      data?: {
        public_metrics?: {
          retweet_count?: number;
          reply_count?: number;
          like_count?: number;
          impression_count?: number;
        };
        non_public_metrics?: { url_link_clicks?: number };
      };
    };

    const pm = data.data?.public_metrics ?? {};
    return {
      impressions: pm.impression_count ?? 0,
      clicks: data.data?.non_public_metrics?.url_link_clicks ?? 0,
      opens: 0,
      reactions: pm.like_count ?? 0,
      shares: pm.retweet_count ?? 0,
      comments: pm.reply_count ?? 0,
      conversions: 0,
      simulated: false,
    };
  }
}
