import type { Channel, ContentItem } from "../db/types.js";

export interface PublishResult {
  externalId: string;
  /** 'simulated' means no credentials were configured; nothing left the server. */
  delivery: "live" | "simulated";
}

export interface FetchedMetrics {
  impressions: number;
  clicks: number;
  opens: number;
  reactions: number;
  shares: number;
  comments: number;
  conversions: number;
  simulated: boolean;
}

export class ChannelError extends Error {
  /** Transient failures are retried on the next sweep; permanent ones are not. */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ChannelError";
    this.retryable = retryable;
  }
}

export interface ChannelAdapter {
  readonly channel: Channel;
  /** False when credentials are missing; the adapter then simulates. */
  isConfigured(): boolean;
  /** Human-readable reason the channel is not live, for the dashboard. */
  configHint(): string;
  publish(item: ContentItem): Promise<PublishResult>;
  fetchMetrics(item: ContentItem): Promise<FetchedMetrics>;
}

export interface ChannelLimits {
  maxBodyChars: number;
  maxHashtags: number;
  needsSubject: boolean;
}

/**
 * Hard platform limits, used both to steer generation and to reject copy that
 * would be rejected by the platform anyway.
 */
export const CHANNEL_LIMITS: Record<Channel, ChannelLimits> = {
  // Generous but finite: long emails are fine, runaway ones are not.
  email: { maxBodyChars: 8000, maxHashtags: 0, needsSubject: true },
  // X allows 280 for standard accounts.
  x: { maxBodyChars: 280, maxHashtags: 3, needsSubject: false },
  // LinkedIn truncates at 3000.
  linkedin: { maxBodyChars: 3000, maxHashtags: 5, needsSubject: false },
  facebook: { maxBodyChars: 5000, maxHashtags: 5, needsSubject: false },
  // Instagram captions cap at 2200.
  instagram: { maxBodyChars: 2200, maxHashtags: 15, needsSubject: false },
};

/** Formats body plus hashtags into the single string a social platform takes. */
export function composeSocialText(item: ContentItem): string {
  const tags: string[] = JSON.parse(item.hashtags);
  if (tags.length === 0) return item.body;
  const suffix = tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");
  const combined = `${item.body}\n\n${suffix}`;
  // Never let hashtags push the post over the platform limit.
  const limit = CHANNEL_LIMITS[item.channel].maxBodyChars;
  return combined.length <= limit ? combined : item.body;
}
