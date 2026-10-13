import { config } from "../config.js";
import { getDb } from "../db/index.js";
import type { Channel, ContentItem } from "../db/types.js";
import { simulateMetrics, simulatedExternalId } from "./simulate.js";
import {
  ChannelError,
  type ChannelAdapter,
  type FetchedMetrics,
  type PublishResult,
} from "./types.js";

/**
 * Email via Resend. The lowest-friction channel: an API key and a verified
 * sending domain are all that is required, with no platform review.
 *
 * Recipients come from the business's own audience list. This adapter sends to
 * the configured audience id; it never scrapes or buys addresses.
 */
export class EmailAdapter implements ChannelAdapter {
  readonly channel: Channel = "email";

  isConfigured(): boolean {
    return (
      config.channels.email.apiKey !== "" && config.channels.email.from !== ""
    );
  }

  configHint(): string {
    if (config.channels.email.apiKey === "") {
      return "Set RESEND_API_KEY (resend.com - no approval needed).";
    }
    if (config.channels.email.from === "") {
      return "Set EMAIL_FROM to a verified sending address.";
    }
    return "Ready.";
  }

  private audienceId(businessId: string): string | null {
    const row = getDb()
      .prepare(
        `SELECT handle FROM channel_accounts
         WHERE business_id = ? AND channel = 'email'`,
      )
      .get(businessId) as unknown as { handle: string | null } | undefined;
    return row?.handle ?? null;
  }

  async publish(item: ContentItem): Promise<PublishResult> {
    if (!this.isConfigured()) {
      return { externalId: simulatedExternalId(item), delivery: "simulated" };
    }

    const audienceId = this.audienceId(item.business_id);
    if (!audienceId) {
      throw new ChannelError(
        "No Resend audience id configured for this business.",
        false,
      );
    }

    const res = await fetch("https://api.resend.com/broadcasts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.channels.email.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audience_id: audienceId,
        from: config.channels.email.from,
        subject: item.subject ?? "",
        text: item.body,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new ChannelError(
        `Resend broadcast failed (${res.status}): ${detail.slice(0, 300)}`,
        res.status === 429 || res.status >= 500,
      );
    }

    const created = (await res.json()) as { id?: string };
    if (!created.id) {
      throw new ChannelError("Resend returned no broadcast id.", false);
    }

    // Creating a broadcast does not send it; this is the send step.
    const sendRes = await fetch(
      `https://api.resend.com/broadcasts/${created.id}/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.channels.email.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );

    if (!sendRes.ok) {
      const detail = await sendRes.text().catch(() => "");
      throw new ChannelError(
        `Resend send failed (${sendRes.status}): ${detail.slice(0, 300)}`,
        sendRes.status === 429 || sendRes.status >= 500,
      );
    }

    return { externalId: created.id, delivery: "live" };
  }

  async fetchMetrics(item: ContentItem): Promise<FetchedMetrics> {
    if (!this.isConfigured() || item.delivery === "simulated") {
      return simulateMetrics(item);
    }
    if (!item.external_id) {
      throw new ChannelError("Cannot fetch metrics without a broadcast id.", false);
    }

    const res = await fetch(
      `https://api.resend.com/broadcasts/${item.external_id}`,
      {
        headers: { Authorization: `Bearer ${config.channels.email.apiKey}` },
      },
    );
    if (!res.ok) {
      throw new ChannelError(
        `Resend metrics fetch failed (${res.status}).`,
        res.status === 429 || res.status >= 500,
      );
    }

    const data = (await res.json()) as {
      sent?: number;
      delivered?: number;
      opened?: number;
      clicked?: number;
    };

    return {
      impressions: data.delivered ?? data.sent ?? 0,
      opens: data.opened ?? 0,
      clicks: data.clicked ?? 0,
      reactions: 0,
      shares: 0,
      comments: 0,
      // Conversions require your own site analytics; wire them in there.
      conversions: 0,
      simulated: false,
    };
  }
}
