import { config } from "../config.js";
import { adapterFor } from "../channels/registry.js";
import { ChannelError } from "../channels/types.js";
import {
  dueContentItems,
  getBusiness,
  logEvent,
  markFailed,
  markPublished,
  markPublishing,
  setItemStatus,
} from "../db/index.js";
import type { ContentItem } from "../db/types.js";
import { websiteForBusiness } from "../db/websites.js";
import { tagLinks } from "./attribution.js";

/** Give up on an item after this many failed attempts. */
const MAX_ATTEMPTS = 4;

export interface PublishSweepResult {
  considered: number;
  published: number;
  simulated: number;
  failed: number;
  skipped: number;
}

/**
 * Publishes everything that is due.
 *
 * Three independent gates must all be open for anything to leave the server:
 * the global PUBLISHING_ENABLED switch, the business's own autopilot flag, and
 * the item being in 'scheduled' state (items held for review are 'draft').
 */
export async function runPublishSweep(
  asOf = new Date(),
): Promise<PublishSweepResult> {
  const result: PublishSweepResult = {
    considered: 0,
    published: 0,
    simulated: 0,
    failed: 0,
    skipped: 0,
  };

  if (!config.publishingEnabled) {
    return result;
  }

  const due = dueContentItems(50, asOf.toISOString());
  result.considered = due.length;

  for (const item of due) {
    const business = getBusiness(item.business_id);
    if (!business || business.autopilot !== 1) {
      setItemStatus(item.id, "skipped");
      result.skipped += 1;
      logEvent("publish.skipped", `Autopilot off; skipped ${item.channel} post`, {
        businessId: item.business_id,
        data: { itemId: item.id },
      });
      continue;
    }

    // Claim the item. If another sweep got there first, move on.
    if (!markPublishing(item.id)) {
      result.skipped += 1;
      continue;
    }

    await publishOne(item, result);
  }

  return result;
}

async function publishOne(
  item: ContentItem,
  result: PublishSweepResult,
): Promise<void> {
  try {
    const adapter = adapterFor(item.channel);

    // Tag links to the business's own site so the resulting visits can be
    // attributed back to this post. Done at send time, not at planning time,
    // so a re-plan never invalidates an already-tagged link.
    const site = websiteForBusiness(item.business_id);
    const outgoing: ContentItem = site
      ? { ...item, body: tagLinks(item.body, item, site) }
      : item;

    const { externalId, delivery } = await adapter.publish(outgoing);
    markPublished(item.id, externalId, delivery);

    if (delivery === "simulated") {
      result.simulated += 1;
    } else {
      result.published += 1;
    }

    logEvent(
      "publish.sent",
      `${delivery === "simulated" ? "Simulated" : "Published"} ${item.channel} post`,
      {
        businessId: item.business_id,
        data: { itemId: item.id, externalId, delivery, pillar: item.pillar },
      },
    );
  } catch (err) {
    result.failed += 1;
    const message = err instanceof Error ? err.message : String(err);
    // attempts was incremented when the item was claimed.
    const exhausted = item.attempts + 1 >= MAX_ATTEMPTS;
    const retryable = err instanceof ChannelError ? err.retryable : false;
    const willRetry = retryable && !exhausted;

    markFailed(item.id, message, willRetry);
    logEvent(
      "publish.failed",
      `${item.channel} publish failed${willRetry ? " (will retry)" : ""}: ${message}`,
      {
        businessId: item.business_id,
        level: "error",
        data: { itemId: item.id, attempts: item.attempts + 1, willRetry },
      },
    );
  }
}
