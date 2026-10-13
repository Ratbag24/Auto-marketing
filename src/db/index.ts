import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import type {
  BrandProfile,
  BrandProfileRow,
  Business,
  Channel,
  ContentItem,
  EventRow,
  ItemStatus,
  MetricRow,
  PlanRun,
} from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(config.databasePath), { recursive: true });
  db = new DatabaseSync(config.databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // schema.sql sits beside this file once compiled; fall back to source tree.
  const candidates = [
    join(here, "schema.sql"),
    join(here, "../../src/db/schema.sql"),
  ];
  let schema: string | null = null;
  for (const path of candidates) {
    try {
      schema = readFileSync(path, "utf8");
      break;
    } catch {
      /* try next */
    }
  }
  if (schema === null) {
    throw new Error(`Could not locate schema.sql (looked in: ${candidates.join(", ")})`);
  }
  db.exec(schema);
  return db;
}

/** Test seam: point the whole app at an in-memory database. */
export function useInMemoryDb(): DatabaseSync {
  const fresh = new DatabaseSync(":memory:");
  fresh.exec("PRAGMA foreign_keys = ON");
  const candidates = [
    join(here, "schema.sql"),
    join(here, "../../src/db/schema.sql"),
  ];
  for (const path of candidates) {
    try {
      fresh.exec(readFileSync(path, "utf8"));
      db = fresh;
      return fresh;
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not locate schema.sql for in-memory database");
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

export function logEvent(
  type: string,
  message: string,
  opts: {
    businessId?: string | null;
    level?: "info" | "warn" | "error";
    data?: unknown;
  } = {},
): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, business_id, level, type, message, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("evt"),
      opts.businessId ?? null,
      opts.level ?? "info",
      type,
      message,
      opts.data === undefined ? null : JSON.stringify(opts.data),
      nowIso(),
    );
}

export function recentEvents(limit = 50, businessId?: string): EventRow[] {
  const sql = businessId
    ? `SELECT * FROM events WHERE business_id = ? ORDER BY created_at DESC LIMIT ?`
    : `SELECT * FROM events ORDER BY created_at DESC LIMIT ?`;
  const params = businessId ? [businessId, limit] : [limit];
  return getDb().prepare(sql).all(...params) as unknown as EventRow[];
}

// --------------------------------------------------------------------------
// Businesses
// --------------------------------------------------------------------------

export interface NewBusiness {
  name: string;
  website?: string | null;
  one_liner: string;
  audience: string;
  tone: string;
  timezone?: string;
  weekly_volume?: number;
  approval_mode?: "auto" | "review";
}

export function createBusiness(input: NewBusiness): Business {
  const id = newId("biz");
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO businesses
         (id, name, website, one_liner, audience, tone, timezone,
          approval_mode, autopilot, weekly_volume, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      input.name,
      input.website ?? null,
      input.one_liner,
      input.audience,
      input.tone,
      input.timezone ?? "UTC",
      input.approval_mode ?? "auto",
      input.weekly_volume ?? 10,
      ts,
      ts,
    );
  return getBusiness(id)!;
}

export function getBusiness(id: string): Business | null {
  const row = getDb()
    .prepare(`SELECT * FROM businesses WHERE id = ?`)
    .get(id) as unknown as Business | undefined;
  return row ?? null;
}

export function listBusinesses(): Business[] {
  return getDb()
    .prepare(`SELECT * FROM businesses ORDER BY created_at DESC`)
    .all() as unknown as Business[];
}

export function updateBusiness(
  id: string,
  patch: Partial<
    Pick<
      Business,
      | "name"
      | "website"
      | "one_liner"
      | "audience"
      | "tone"
      | "timezone"
      | "approval_mode"
      | "autopilot"
      | "weekly_volume"
    >
  >,
): Business | null {
  const fields = Object.keys(patch) as (keyof typeof patch)[];
  if (fields.length === 0) return getBusiness(id);
  const sets = fields.map((f) => `${f} = ?`).join(", ");
  const values = fields.map((f) => patch[f] as string | number | null);
  getDb()
    .prepare(`UPDATE businesses SET ${sets}, updated_at = ? WHERE id = ?`)
    .run(...values, nowIso(), id);
  return getBusiness(id);
}

// --------------------------------------------------------------------------
// Brand profiles
// --------------------------------------------------------------------------

function decodeBrand(row: BrandProfileRow): BrandProfile {
  return {
    id: row.id,
    business_id: row.business_id,
    version: row.version,
    positioning: row.positioning,
    value_props: JSON.parse(row.value_props),
    segments: JSON.parse(row.segments),
    pillars: JSON.parse(row.pillars),
    voice: JSON.parse(row.voice),
    created_at: row.created_at,
  };
}

export function saveBrandProfile(
  businessId: string,
  profile: Omit<BrandProfile, "id" | "business_id" | "version" | "created_at">,
): BrandProfile {
  const current = getDb()
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS v FROM brand_profiles WHERE business_id = ?`,
    )
    .get(businessId) as unknown as { v: number };
  const id = newId("brand");
  getDb()
    .prepare(
      `INSERT INTO brand_profiles
         (id, business_id, version, positioning, value_props, segments,
          pillars, voice, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      businessId,
      current.v + 1,
      profile.positioning,
      JSON.stringify(profile.value_props),
      JSON.stringify(profile.segments),
      JSON.stringify(profile.pillars),
      JSON.stringify(profile.voice),
      nowIso(),
    );
  return getBrandProfile(businessId)!;
}

export function getBrandProfile(businessId: string): BrandProfile | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM brand_profiles WHERE business_id = ?
       ORDER BY version DESC LIMIT 1`,
    )
    .get(businessId) as unknown as BrandProfileRow | undefined;
  return row ? decodeBrand(row) : null;
}

// --------------------------------------------------------------------------
// Channel accounts
// --------------------------------------------------------------------------

export function enableChannel(
  businessId: string,
  channel: Channel,
  handle?: string | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO channel_accounts (id, business_id, channel, handle, enabled, created_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (business_id, channel)
       DO UPDATE SET enabled = 1, handle = COALESCE(excluded.handle, handle)`,
    )
    .run(newId("chan"), businessId, channel, handle ?? null, nowIso());
}

export function setChannelEnabled(
  businessId: string,
  channel: Channel,
  enabled: boolean,
): void {
  getDb()
    .prepare(
      `UPDATE channel_accounts SET enabled = ? WHERE business_id = ? AND channel = ?`,
    )
    .run(enabled ? 1 : 0, businessId, channel);
}

export function enabledChannels(businessId: string): Channel[] {
  const rows = getDb()
    .prepare(
      `SELECT channel FROM channel_accounts
       WHERE business_id = ? AND enabled = 1 ORDER BY channel`,
    )
    .all(businessId) as unknown as { channel: Channel }[];
  return rows.map((r) => r.channel);
}

// --------------------------------------------------------------------------
// Content items
// --------------------------------------------------------------------------

export interface NewContentItem {
  business_id: string;
  plan_run_id?: string | null;
  channel: Channel;
  pillar: string;
  subject?: string | null;
  body: string;
  hashtags?: string[];
  cta?: string | null;
  scheduled_at: string;
  status?: ItemStatus;
}

export function createContentItem(input: NewContentItem): ContentItem {
  const id = newId("item");
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO content_items
         (id, business_id, plan_run_id, channel, pillar, subject, body,
          hashtags, cta, scheduled_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.business_id,
      input.plan_run_id ?? null,
      input.channel,
      input.pillar,
      input.subject ?? null,
      input.body,
      JSON.stringify(input.hashtags ?? []),
      input.cta ?? null,
      input.scheduled_at,
      input.status ?? "scheduled",
      ts,
      ts,
    );
  return getContentItem(id)!;
}

export function getContentItem(id: string): ContentItem | null {
  const row = getDb()
    .prepare(`SELECT * FROM content_items WHERE id = ?`)
    .get(id) as unknown as ContentItem | undefined;
  return row ?? null;
}

/**
 * Items that are due to go out. Only picks up 'scheduled' rows, so an item
 * held for review (status 'draft') is never published by the sweep.
 */
export function dueContentItems(limit = 25, asOf = nowIso()): ContentItem[] {
  return getDb()
    .prepare(
      `SELECT * FROM content_items
       WHERE status = 'scheduled' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC LIMIT ?`,
    )
    .all(asOf, limit) as unknown as ContentItem[];
}

export function listContentItems(
  businessId: string,
  opts: { status?: ItemStatus; limit?: number } = {},
): ContentItem[] {
  const limit = opts.limit ?? 100;
  if (opts.status) {
    return getDb()
      .prepare(
        `SELECT * FROM content_items WHERE business_id = ? AND status = ?
         ORDER BY scheduled_at DESC LIMIT ?`,
      )
      .all(businessId, opts.status, limit) as unknown as ContentItem[];
  }
  return getDb()
    .prepare(
      `SELECT * FROM content_items WHERE business_id = ?
       ORDER BY scheduled_at DESC LIMIT ?`,
    )
    .all(businessId, limit) as unknown as ContentItem[];
}

export function markPublishing(id: string): boolean {
  // Conditional update doubles as a lock: only one sweep can claim an item.
  const res = getDb()
    .prepare(
      `UPDATE content_items
       SET status = 'publishing', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'scheduled'`,
    )
    .run(nowIso(), id);
  return Number(res.changes) === 1;
}

export function markPublished(
  id: string,
  externalId: string,
  delivery: "live" | "simulated",
): void {
  const ts = nowIso();
  getDb()
    .prepare(
      `UPDATE content_items
       SET status = 'published', external_id = ?, delivery = ?,
           published_at = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .run(externalId, delivery, ts, ts, id);
}

export function markFailed(id: string, error: string, retry: boolean): void {
  getDb()
    .prepare(
      `UPDATE content_items SET status = ?, error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(retry ? "scheduled" : "failed", error.slice(0, 1000), nowIso(), id);
}

/** Only used to build historical demo data; publishing always stamps now. */
export function backdatePublishedAt(id: string, publishedAt: string): void {
  getDb()
    .prepare(`UPDATE content_items SET published_at = ? WHERE id = ?`)
    .run(publishedAt, id);
}

export function setItemStatus(id: string, status: ItemStatus): void {
  getDb()
    .prepare(`UPDATE content_items SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), id);
}

/** Published items worth polling for fresh metrics (first 30 days). */
export function itemsNeedingMetrics(limit = 100): ContentItem[] {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM content_items
       WHERE status = 'published' AND published_at >= ?
       ORDER BY published_at DESC LIMIT ?`,
    )
    .all(cutoff, limit) as unknown as ContentItem[];
}

// --------------------------------------------------------------------------
// Metrics
// --------------------------------------------------------------------------

export type MetricInput = Omit<MetricRow, "id" | "captured_at">;

export function recordMetrics(
  input: MetricInput,
  capturedAt: string = nowIso(),
): void {
  getDb()
    .prepare(
      `INSERT INTO metrics
         (id, content_item_id, business_id, channel, captured_at, impressions,
          clicks, opens, reactions, shares, comments, conversions, simulated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("met"),
      input.content_item_id,
      input.business_id,
      input.channel,
      capturedAt,
      input.impressions,
      input.clicks,
      input.opens,
      input.reactions,
      input.shares,
      input.comments,
      input.conversions,
      input.simulated,
    );
}

/**
 * Latest metric row per content item - the current truth for each post.
 *
 * Uses ROW_NUMBER rather than a MAX(captured_at) join: two sweeps can land on
 * the same timestamp, and a join on the max would then match both rows and
 * double every total.
 */
export function latestMetricsByItem(businessId: string): MetricRow[] {
  return getDb()
    .prepare(
      `SELECT id, content_item_id, business_id, channel, captured_at,
              impressions, clicks, opens, reactions, shares, comments,
              conversions, simulated
       FROM (
         SELECT m.*,
                ROW_NUMBER() OVER (
                  PARTITION BY m.content_item_id
                  ORDER BY m.captured_at DESC, m.id DESC
                ) AS rn
         FROM metrics m
         WHERE m.business_id = ?
       )
       WHERE rn = 1`,
    )
    .all(businessId) as unknown as MetricRow[];
}


// --------------------------------------------------------------------------
// Plan runs
// --------------------------------------------------------------------------

export function startPlanRun(businessId: string): PlanRun {
  const id = newId("plan");
  getDb()
    .prepare(
      `INSERT INTO plan_runs (id, business_id, started_at, status)
       VALUES (?, ?, ?, 'running')`,
    )
    .run(id, businessId, nowIso());
  return getPlanRun(id)!;
}

export function finishPlanRun(
  id: string,
  patch: {
    status: "succeeded" | "failed";
    items_created?: number;
    strategy_note?: string | null;
    input_tokens?: number;
    output_tokens?: number;
    cached_tokens?: number;
    error?: string | null;
  },
): void {
  getDb()
    .prepare(
      `UPDATE plan_runs
       SET finished_at = ?, status = ?, items_created = ?, strategy_note = ?,
           input_tokens = ?, output_tokens = ?, cached_tokens = ?, error = ?
       WHERE id = ?`,
    )
    .run(
      nowIso(),
      patch.status,
      patch.items_created ?? 0,
      patch.strategy_note ?? null,
      patch.input_tokens ?? 0,
      patch.output_tokens ?? 0,
      patch.cached_tokens ?? 0,
      patch.error ?? null,
      id,
    );
}

export function getPlanRun(id: string): PlanRun | null {
  const row = getDb()
    .prepare(`SELECT * FROM plan_runs WHERE id = ?`)
    .get(id) as unknown as PlanRun | undefined;
  return row ?? null;
}

export function lastPlanRun(businessId: string): PlanRun | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM plan_runs WHERE business_id = ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(businessId) as unknown as PlanRun | undefined;
  return row ?? null;
}

export function listPlanRuns(businessId: string, limit = 20): PlanRun[] {
  return getDb()
    .prepare(
      `SELECT * FROM plan_runs WHERE business_id = ?
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(businessId, limit) as unknown as PlanRun[];
}
