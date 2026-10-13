import { config } from "../config.js";
import { generateBrandProfile } from "../ai/brand.js";
import { planCampaign } from "../ai/planner.js";
import { channelStatuses } from "../channels/registry.js";
import { ALL_CHANNELS, type Channel } from "../db/types.js";
import {
  createBusiness,
  enableChannel,
  getBrandProfile,
  getBusiness,
  getContentItem,
  listBusinesses,
  listContentItems,
  listPlanRuns,
  logEvent,
  recentEvents,
  setChannelEnabled,
  setItemStatus,
  updateBusiness,
} from "../db/index.js";
import { runMetricsSweep } from "../engine/metrics.js";
import { runPublishSweep } from "../engine/publisher.js";
import { runPlanningSweep } from "../engine/scheduler.js";
import { buildBusinessStats } from "../engine/stats.js";
import { buildWebsiteOverview } from "../engine/audience.js";
import { runMonitorSweep, checkWebsite } from "../web/monitor.js";
import { crawlWebsite } from "../web/crawler.js";
import { runCrawlSweep } from "../engine/scheduler.js";
import { assertFetchable } from "../web/url-guard.js";
import { snippetFor } from "../web/tracker.js";
import {
  createWebsite,
  deleteWebsite,
  updateWebsite,
  websiteForBusiness,
} from "../db/websites.js";

export interface ApiResult {
  status: number;
  body: unknown;
}

const ok = (body: unknown): ApiResult => ({ status: 200, body });
const bad = (message: string): ApiResult => ({
  status: 400,
  body: { error: message },
});
const missing = (what: string): ApiResult => ({
  status: 404,
  body: { error: `${what} not found` },
});

function requireString(
  body: Record<string, unknown>,
  field: string,
  max = 2000,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" is required`);
  }
  if (value.length > max) {
    throw new Error(`"${field}" must be at most ${max} characters`);
  }
  return value.trim();
}

export async function handleApi(
  method: string,
  url: URL,
  rawBody: unknown,
): Promise<ApiResult> {
  const body = (rawBody ?? {}) as Record<string, unknown>;
  const path = url.pathname.replace(/\/+$/, "");

  // ---- system ----------------------------------------------------------

  if (method === "GET" && path === "/api/overview") {
    const businesses = listBusinesses();
    return ok({
      businesses: businesses.map((b) => ({
        id: b.id,
        name: b.name,
        autopilot: b.autopilot === 1,
        approval_mode: b.approval_mode,
      })),
      channels: channelStatuses(),
      publishing_enabled: config.publishingEnabled,
      model: config.model,
      events: recentEvents(25),
    });
  }

  // ---- onboarding ------------------------------------------------------

  if (method === "POST" && path === "/api/businesses") {
    let fields;
    try {
      fields = {
        name: requireString(body, "name", 200),
        one_liner: requireString(body, "one_liner", 500),
        audience: requireString(body, "audience", 500),
        tone: requireString(body, "tone", 200),
      };
    } catch (err) {
      return bad(err instanceof Error ? err.message : String(err));
    }

    const website =
      typeof body["website"] === "string" && body["website"].trim() !== ""
        ? body["website"].trim()
        : null;

    const requested = Array.isArray(body["channels"])
      ? (body["channels"] as unknown[]).filter(
          (c): c is Channel =>
            typeof c === "string" && (ALL_CHANNELS as string[]).includes(c),
        )
      : (["email", "x", "linkedin"] as Channel[]);

    if (requested.length === 0) {
      return bad("Select at least one channel");
    }

    const weeklyVolume =
      typeof body["weekly_volume"] === "number" && body["weekly_volume"] > 0
        ? Math.min(50, Math.round(body["weekly_volume"]))
        : 10;

    const business = createBusiness({
      ...fields,
      website,
      weekly_volume: weeklyVolume,
      approval_mode:
        body["approval_mode"] === "review" ? "review" : "auto",
    });

    for (const channel of requested) {
      enableChannel(business.id, channel, null);
    }

    logEvent("business.created", `Onboarded ${business.name}`, {
      businessId: business.id,
      data: { channels: requested },
    });

    // Brand analysis and the first calendar are the only slow part of
    // onboarding; both run here so the business is productive immediately.
    try {
      await generateBrandProfile(business);
      const plan = await planCampaign(business);
      return ok({
        business,
        brand: getBrandProfile(business.id),
        plan: {
          items_created: plan.itemsCreated,
          strategy_note: plan.strategyNote,
          rejected: plan.skipped,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The business exists; it just has no content yet. Say so plainly.
      return {
        status: 502,
        body: {
          business,
          error: `Business created, but generation failed: ${message}`,
        },
      };
    }
  }

  // ---- per-business ----------------------------------------------------

  const bizMatch = /^\/api\/businesses\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (bizMatch) {
    const business = getBusiness(bizMatch[1]!);
    if (!business) return missing("Business");
    const sub = bizMatch[2];

    if (method === "GET" && sub === undefined) {
      return ok(buildBusinessStats(business, config.model));
    }

    if (method === "GET" && sub === "content") {
      return ok({
        items: listContentItems(business.id, { limit: 200 }),
      });
    }

    if (method === "GET" && sub === "brand") {
      const brand = getBrandProfile(business.id);
      return brand ? ok(brand) : missing("Brand profile");
    }

    // ---- website -------------------------------------------------------

    if (method === "GET" && sub === "website") {
      const overview = buildWebsiteOverview(business.id);
      const base = config.publicUrl || `http://localhost:${config.port}`;
      return ok({
        ...overview,
        snippet: overview.website
          ? snippetFor(base, overview.website.tracking_key)
          : null,
      });
    }

    if (method === "POST" && sub === "website") {
      const raw = typeof body["url"] === "string" ? body["url"] : "";
      if (raw.trim() === "") return bad('"url" is required');

      // Resolve before storing: refuse anything that points at a private
      // address, so this server cannot be aimed at an internal host.
      const check = await assertFetchable(raw);
      if (!check.ok || !check.url) {
        return bad(check.reason ?? "That address cannot be monitored.");
      }

      const existing = websiteForBusiness(business.id);
      if (existing) {
        const updated = updateWebsite(existing.id, {
          url: check.url.origin,
          expected_text:
            typeof body["expected_text"] === "string"
              ? body["expected_text"].slice(0, 200)
              : existing.expected_text,
          goal_path:
            typeof body["goal_path"] === "string"
              ? body["goal_path"].slice(0, 200)
              : existing.goal_path,
        });
        return ok({ website: updated, created: false });
      }

      const site = createWebsite(business.id, check.url.origin, {
        expected_text:
          typeof body["expected_text"] === "string"
            ? body["expected_text"].slice(0, 200)
            : null,
        goal_path:
          typeof body["goal_path"] === "string"
            ? body["goal_path"].slice(0, 200)
            : null,
      });

      logEvent("site.connected", `Connected ${site.url}`, {
        businessId: business.id,
      });

      // First check and crawl happen immediately, so the dashboard has
      // something to show rather than an empty panel.
      let crawl = null;
      try {
        await runMonitorSweep();
        crawl = await crawlWebsite(site);
      } catch (err) {
        logEvent(
          "site.crawl_failed",
          err instanceof Error ? err.message : String(err),
          { businessId: business.id, level: "warn" },
        );
      }

      const base = config.publicUrl || `http://localhost:${config.port}`;
      return ok({
        website: site,
        created: true,
        crawl,
        snippet: snippetFor(base, site.tracking_key),
      });
    }

    if (method === "PATCH" && sub === "website") {
      const site = websiteForBusiness(business.id);
      if (!site) return missing("Website");
      const patch: Record<string, string | number | null> = {};
      if (typeof body["expected_text"] === "string") {
        patch["expected_text"] = body["expected_text"].slice(0, 200) || null;
      }
      if (typeof body["goal_path"] === "string") {
        patch["goal_path"] = body["goal_path"].slice(0, 200) || null;
      }
      if (typeof body["monitor_enabled"] === "boolean") {
        patch["monitor_enabled"] = body["monitor_enabled"] ? 1 : 0;
      }
      return ok(updateWebsite(site.id, patch));
    }

    if (method === "DELETE" && sub === "website") {
      const site = websiteForBusiness(business.id);
      if (!site) return missing("Website");
      deleteWebsite(site.id);
      logEvent("site.disconnected", `Disconnected ${site.url}`, {
        businessId: business.id,
      });
      return ok({ deleted: true });
    }

    if (method === "POST" && sub === "crawl") {
      const site = websiteForBusiness(business.id);
      if (!site) return missing("Website");
      try {
        return ok(await crawlWebsite(site));
      } catch (err) {
        return {
          status: 502,
          body: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    if (method === "POST" && sub === "check") {
      const site = websiteForBusiness(business.id);
      if (!site) return missing("Website");
      await runMonitorSweep();
      return ok(await checkWebsite(site));
    }

    if (method === "GET" && sub === "plans") {
      return ok({ runs: listPlanRuns(business.id) });
    }

    if (method === "POST" && sub === "plan") {
      try {
        const result = await planCampaign(business);
        return ok(result);
      } catch (err) {
        return {
          status: 502,
          body: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    if (method === "POST" && sub === "brand") {
      try {
        return ok(await generateBrandProfile(business));
      } catch (err) {
        return {
          status: 502,
          body: { error: err instanceof Error ? err.message : String(err) },
        };
      }
    }

    if (method === "PATCH" && sub === undefined) {
      const patch: Record<string, string | number> = {};
      if (typeof body["autopilot"] === "boolean") {
        patch["autopilot"] = body["autopilot"] ? 1 : 0;
      }
      if (body["approval_mode"] === "auto" || body["approval_mode"] === "review") {
        patch["approval_mode"] = body["approval_mode"];
      }
      if (typeof body["weekly_volume"] === "number") {
        patch["weekly_volume"] = Math.min(
          50,
          Math.max(1, Math.round(body["weekly_volume"])),
        );
      }
      for (const field of ["name", "one_liner", "audience", "tone", "timezone"]) {
        if (typeof body[field] === "string" && body[field] !== "") {
          patch[field] = body[field] as string;
        }
      }
      const updated = updateBusiness(business.id, patch);
      logEvent("business.updated", `Settings changed`, {
        businessId: business.id,
        data: patch,
      });
      return ok(updated);
    }

    if (method === "POST" && sub === "channels") {
      const channel = body["channel"];
      if (
        typeof channel !== "string" ||
        !(ALL_CHANNELS as string[]).includes(channel)
      ) {
        return bad(`"channel" must be one of ${ALL_CHANNELS.join(", ")}`);
      }
      const enabled = body["enabled"] !== false;
      if (enabled) {
        enableChannel(
          business.id,
          channel as Channel,
          typeof body["handle"] === "string" ? body["handle"] : null,
        );
      } else {
        setChannelEnabled(business.id, channel as Channel, false);
      }
      return ok({ channel, enabled });
    }

    return bad(`Unsupported route: ${method} ${path}`);
  }

  // ---- content item actions -------------------------------------------

  const itemMatch = /^\/api\/items\/([^/]+)\/(approve|reject)$/.exec(path);
  if (method === "POST" && itemMatch) {
    const item = getContentItem(itemMatch[1]!);
    if (!item) return missing("Content item");
    if (itemMatch[2] === "approve") {
      if (item.status !== "draft") {
        return bad(`Only draft items can be approved (this one is ${item.status})`);
      }
      setItemStatus(item.id, "scheduled");
      logEvent("item.approved", `Approved ${item.channel} post`, {
        businessId: item.business_id,
        data: { itemId: item.id },
      });
      return ok({ id: item.id, status: "scheduled" });
    }
    setItemStatus(item.id, "skipped");
    logEvent("item.rejected", `Rejected ${item.channel} post`, {
      businessId: item.business_id,
      data: { itemId: item.id },
    });
    return ok({ id: item.id, status: "skipped" });
  }

  // ---- manual sweeps (useful for testing and for cron-driven deploys) --

  if (method === "POST" && path === "/api/sweeps/publish") {
    return ok(await runPublishSweep());
  }
  if (method === "POST" && path === "/api/sweeps/metrics") {
    return ok(await runMetricsSweep());
  }
  if (method === "POST" && path === "/api/sweeps/plan") {
    return ok(await runPlanningSweep());
  }
  if (method === "POST" && path === "/api/sweeps/monitor") {
    return ok(await runMonitorSweep());
  }
  if (method === "POST" && path === "/api/sweeps/crawl") {
    return ok(await runCrawlSweep());
  }

  return missing("Route");
}
