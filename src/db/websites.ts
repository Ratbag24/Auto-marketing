import { randomBytes } from "node:crypto";
import { getDb, newId, nowIso } from "./index.js";

export interface Website {
  id: string;
  business_id: string;
  url: string;
  tracking_key: string;
  verified_at: string | null;
  monitor_enabled: number;
  expected_text: string | null;
  goal_path: string | null;
  last_crawled_at: string | null;
  created_at: string;
}

export interface PageRow {
  id: string;
  website_id: string;
  url: string;
  path: string;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  excerpt: string | null;
  word_count: number;
  status_code: number | null;
  internal_links: number;
  external_links: number;
  issues: string;
  crawled_at: string;
}

export type Verdict = "up" | "down" | "broken" | "slow" | "content_missing";

export interface HealthCheckRow {
  id: string;
  website_id: string;
  checked_at: string;
  ok: number;
  status_code: number | null;
  response_ms: number | null;
  ssl_days_left: number | null;
  verdict: Verdict;
  error: string | null;
}

export interface Incident {
  id: string;
  website_id: string;
  started_at: string;
  resolved_at: string | null;
  kind: string;
  detail: string | null;
  checks_failed: number;
}

export interface VisitInput {
  website_id: string;
  business_id: string;
  visitor_hash: string;
  session_id: string;
  path: string;
  referrer: string | null;
  referrer_source: string | null;
  country: string | null;
  region: string | null;
  timezone: string | null;
  language: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  content_item_id: string | null;
  is_entry: number;
  is_goal: number;
  duration_ms: number;
}

// --------------------------------------------------------------------------
// Websites
// --------------------------------------------------------------------------

export function createWebsite(
  businessId: string,
  url: string,
  opts: { expected_text?: string | null; goal_path?: string | null } = {},
): Website {
  const id = newId("site");
  getDb()
    .prepare(
      `INSERT INTO websites
         (id, business_id, url, tracking_key, monitor_enabled,
          expected_text, goal_path, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    )
    .run(
      id,
      businessId,
      url.replace(/\/+$/, ""),
      `am_${randomBytes(12).toString("hex")}`,
      opts.expected_text ?? null,
      opts.goal_path ?? null,
      nowIso(),
    );
  return getWebsite(id)!;
}

export function getWebsite(id: string): Website | null {
  return (getDb()
    .prepare(`SELECT * FROM websites WHERE id = ?`)
    .get(id) as unknown as Website | undefined) ?? null;
}

export function getWebsiteByKey(trackingKey: string): Website | null {
  return (getDb()
    .prepare(`SELECT * FROM websites WHERE tracking_key = ?`)
    .get(trackingKey) as unknown as Website | undefined) ?? null;
}

export function websiteForBusiness(businessId: string): Website | null {
  return (getDb()
    .prepare(
      `SELECT * FROM websites WHERE business_id = ? ORDER BY created_at LIMIT 1`,
    )
    .get(businessId) as unknown as Website | undefined) ?? null;
}

export function listMonitoredWebsites(): Website[] {
  return getDb()
    .prepare(`SELECT * FROM websites WHERE monitor_enabled = 1`)
    .all() as unknown as Website[];
}

export function listWebsites(): Website[] {
  return getDb().prepare(`SELECT * FROM websites`).all() as unknown as Website[];
}

export function updateWebsite(
  id: string,
  patch: Partial<
    Pick<Website, "expected_text" | "goal_path" | "monitor_enabled" | "url">
  >,
): Website | null {
  const fields = Object.keys(patch) as (keyof typeof patch)[];
  if (fields.length === 0) return getWebsite(id);
  const sets = fields.map((f) => `${f} = ?`).join(", ");
  getDb()
    .prepare(`UPDATE websites SET ${sets} WHERE id = ?`)
    .run(...fields.map((f) => patch[f] as string | number | null), id);
  return getWebsite(id);
}

export function markVerified(id: string): void {
  getDb()
    .prepare(`UPDATE websites SET verified_at = ? WHERE id = ? AND verified_at IS NULL`)
    .run(nowIso(), id);
}

export function touchCrawl(id: string, at: string): void {
  getDb().prepare(`UPDATE websites SET last_crawled_at = ? WHERE id = ?`).run(at, id);
}

export function deleteWebsite(id: string): void {
  getDb().prepare(`DELETE FROM websites WHERE id = ?`).run(id);
}

// --------------------------------------------------------------------------
// Pages
// --------------------------------------------------------------------------

export function savePage(input: {
  website_id: string;
  url: string;
  path: string;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  excerpt: string | null;
  word_count: number;
  status_code: number;
  internal_links: number;
  external_links: number;
  issues: string[];
}): void {
  getDb()
    .prepare(
      `INSERT INTO pages
         (id, website_id, url, path, title, meta_description, h1, excerpt,
          word_count, status_code, internal_links, external_links, issues, crawled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (website_id, url) DO UPDATE SET
         title = excluded.title,
         meta_description = excluded.meta_description,
         h1 = excluded.h1,
         excerpt = excluded.excerpt,
         word_count = excluded.word_count,
         status_code = excluded.status_code,
         internal_links = excluded.internal_links,
         external_links = excluded.external_links,
         issues = excluded.issues,
         crawled_at = excluded.crawled_at`,
    )
    .run(
      newId("page"),
      input.website_id,
      input.url,
      input.path,
      input.title,
      input.meta_description,
      input.h1,
      input.excerpt,
      input.word_count,
      input.status_code,
      input.internal_links,
      input.external_links,
      JSON.stringify(input.issues),
      nowIso(),
    );
}

export function listPages(websiteId: string, limit = 100): PageRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM pages WHERE website_id = ? ORDER BY word_count DESC LIMIT ?`,
    )
    .all(websiteId, limit) as unknown as PageRow[];
}

// --------------------------------------------------------------------------
// Health
// --------------------------------------------------------------------------

export function recordHealthCheck(
  input: {
    website_id: string;
    ok: boolean;
    status_code: number | null;
    response_ms: number | null;
    ssl_days_left: number | null;
    verdict: Verdict;
    error: string | null;
  },
  checkedAt: string = nowIso(),
): void {
  getDb()
    .prepare(
      `INSERT INTO health_checks
         (id, website_id, checked_at, ok, status_code, response_ms,
          ssl_days_left, verdict, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("hc"),
      input.website_id,
      checkedAt,
      input.ok ? 1 : 0,
      input.status_code,
      input.response_ms,
      input.ssl_days_left,
      input.verdict,
      input.error,
    );
}

export function recentChecks(websiteId: string, limit = 120): HealthCheckRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM health_checks WHERE website_id = ?
       ORDER BY checked_at DESC, id DESC LIMIT ?`,
    )
    .all(websiteId, limit) as unknown as HealthCheckRow[];
}

export function uptimeSince(websiteId: string, sinceIso: string): {
  total: number;
  ok: number;
  avg_ms: number | null;
} {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(ok), 0) AS ok,
              AVG(CASE WHEN ok = 1 THEN response_ms END) AS avg_ms
       FROM health_checks WHERE website_id = ? AND checked_at >= ?`,
    )
    .get(websiteId, sinceIso) as unknown as {
    total: number;
    ok: number;
    avg_ms: number | null;
  };
  return row;
}

export function openIncident(websiteId: string): Incident | null {
  return (getDb()
    .prepare(
      `SELECT * FROM incidents WHERE website_id = ? AND resolved_at IS NULL
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(websiteId) as unknown as Incident | undefined) ?? null;
}

export function startIncident(
  websiteId: string,
  kind: string,
  detail: string,
  startedAt: string = nowIso(),
): Incident {
  const id = newId("inc");
  getDb()
    .prepare(
      `INSERT INTO incidents (id, website_id, started_at, kind, detail, checks_failed)
       VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .run(id, websiteId, startedAt, kind, detail);
  return (getDb()
    .prepare(`SELECT * FROM incidents WHERE id = ?`)
    .get(id) as unknown as Incident);
}

export function bumpIncident(id: string, detail: string): void {
  getDb()
    .prepare(
      `UPDATE incidents SET checks_failed = checks_failed + 1, detail = ? WHERE id = ?`,
    )
    .run(detail, id);
}

export function resolveIncident(id: string, resolvedAt: string = nowIso()): void {
  getDb()
    .prepare(`UPDATE incidents SET resolved_at = ? WHERE id = ?`)
    .run(resolvedAt, id);
}

export function listIncidents(websiteId: string, limit = 20): Incident[] {
  return getDb()
    .prepare(
      `SELECT * FROM incidents WHERE website_id = ?
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(websiteId, limit) as unknown as Incident[];
}

// --------------------------------------------------------------------------
// Visits
// --------------------------------------------------------------------------

export function recordVisit(input: VisitInput, occurredAt = nowIso()): void {
  getDb()
    .prepare(
      `INSERT INTO visits
         (id, website_id, business_id, occurred_at, visitor_hash, session_id,
          path, referrer, referrer_source, country, region, timezone, language,
          device, browser, os, utm_source, utm_medium, utm_campaign,
          content_item_id, is_entry, is_goal, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId("vis"),
      input.website_id,
      input.business_id,
      occurredAt,
      input.visitor_hash,
      input.session_id,
      input.path,
      input.referrer,
      input.referrer_source,
      input.country,
      input.region,
      input.timezone,
      input.language,
      input.device,
      input.browser,
      input.os,
      input.utm_source,
      input.utm_medium,
      input.utm_campaign,
      input.content_item_id,
      input.is_entry,
      input.is_goal,
      input.duration_ms,
    );
}

/** True when this session already has a recorded visit. */
export function sessionExists(sessionId: string): boolean {
  const row = getDb()
    .prepare(`SELECT 1 AS hit FROM visits WHERE session_id = ? LIMIT 1`)
    .get(sessionId) as unknown as { hit: number } | undefined;
  return row !== undefined;
}
