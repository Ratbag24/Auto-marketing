import { getDb } from "../db/index.js";
import {
  listIncidents,
  listPages,
  recentChecks,
  uptimeSince,
  websiteForBusiness,
  type HealthCheckRow,
  type Incident,
  type PageRow,
  type Website,
} from "../db/websites.js";
import { describeVerdict } from "../web/monitor.js";

export interface Breakdown {
  key: string;
  label: string;
  visitors: number;
  views: number;
  share: number;
}

export interface AudienceStats {
  window_days: number;
  totals: {
    views: number;
    visitors: number;
    sessions: number;
    goals: number;
    bounce_rate: number;
    avg_session_seconds: number;
    pages_per_session: number;
  };
  daily: { date: string; visitors: number; views: number }[];
  countries: Breakdown[];
  regions: Breakdown[];
  devices: Breakdown[];
  browsers: Breakdown[];
  sources: Breakdown[];
  top_pages: { path: string; views: number; visitors: number }[];
  hours: { hour: string; views: number }[];
  /** Visits traced back to a specific published post. */
  attributed: {
    content_item_id: string;
    channel: string;
    pillar: string;
    excerpt: string;
    visits: number;
    goals: number;
  }[];
}

export interface SiteHealth {
  verdict: string;
  description: string;
  last_checked: string | null;
  response_ms: number | null;
  ssl_days_left: number | null;
  uptime_24h: number | null;
  uptime_30d: number | null;
  avg_response_ms: number | null;
  checks_24h: number;
  open_incident: Incident | null;
  incidents: Incident[];
  recent: { at: string; ok: boolean; ms: number | null; verdict: string }[];
}

export interface WebsiteOverview {
  website: Website | null;
  health: SiteHealth | null;
  audience: AudienceStats | null;
  content: {
    pages: PageRow[];
    total_pages: number;
    pages_with_issues: number;
    top_issues: { issue: string; count: number }[];
  } | null;
}

const since = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

function toBreakdown(
  rows: { key: string | null; visitors: number; views: number }[],
  totalViews: number,
  labeller: (key: string) => string = (k) => k,
): Breakdown[] {
  return rows
    .filter((r) => r.key !== null && r.key !== "")
    .map((r) => ({
      key: r.key as string,
      label: labeller(r.key as string),
      visitors: r.visitors,
      views: r.views,
      share: totalViews > 0 ? r.views / totalViews : 0,
    }));
}

const COUNTRY_NAMES: Record<string, string> = {
  GB: "United Kingdom", US: "United States", CA: "Canada", IE: "Ireland",
  AU: "Australia", NZ: "New Zealand", DE: "Germany", FR: "France",
  ES: "Spain", IT: "Italy", NL: "Netherlands", BE: "Belgium", PT: "Portugal",
  AT: "Austria", CH: "Switzerland", SE: "Sweden", NO: "Norway", DK: "Denmark",
  FI: "Finland", PL: "Poland", CZ: "Czechia", GR: "Greece", RU: "Russia",
  UA: "Ukraine", MX: "Mexico", BR: "Brazil", AR: "Argentina", CO: "Colombia",
  CL: "Chile", PE: "Peru", JP: "Japan", KR: "South Korea", CN: "China",
  HK: "Hong Kong", SG: "Singapore", IN: "India", AE: "UAE", ID: "Indonesia",
  PH: "Philippines", TH: "Thailand", IL: "Israel", SA: "Saudi Arabia",
  ZA: "South Africa", NG: "Nigeria", EG: "Egypt", KE: "Kenya",
};

export const countryName = (code: string) => COUNTRY_NAMES[code] ?? code;

export function buildAudienceStats(
  websiteId: string,
  windowDays = 30,
): AudienceStats {
  const db = getDb();
  const from = since(windowDays);

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS views,
              COUNT(DISTINCT visitor_hash) AS visitors,
              COUNT(DISTINCT session_id) AS sessions,
              COALESCE(SUM(is_goal), 0) AS goals
       FROM visits WHERE website_id = ? AND occurred_at >= ?`,
    )
    .get(websiteId, from) as unknown as {
    views: number;
    visitors: number;
    sessions: number;
    goals: number;
  };

  // A bounce is a session with exactly one pageview.
  const bounce = db
    .prepare(
      `SELECT COUNT(*) AS bounced FROM (
         SELECT session_id FROM visits
         WHERE website_id = ? AND occurred_at >= ?
         GROUP BY session_id HAVING COUNT(*) = 1
       )`,
    )
    .get(websiteId, from) as unknown as { bounced: number };

  const dwell = db
    .prepare(
      `SELECT AVG(total) AS avg_ms FROM (
         SELECT SUM(duration_ms) AS total FROM visits
         WHERE website_id = ? AND occurred_at >= ?
         GROUP BY session_id
       )`,
    )
    .get(websiteId, from) as unknown as { avg_ms: number | null };

  const daily = db
    .prepare(
      `SELECT substr(occurred_at, 1, 10) AS date,
              COUNT(DISTINCT visitor_hash) AS visitors,
              COUNT(*) AS views
       FROM visits WHERE website_id = ? AND occurred_at >= ?
       GROUP BY date ORDER BY date ASC`,
    )
    .all(websiteId, from) as unknown as {
    date: string;
    visitors: number;
    views: number;
  }[];

  const groupBy = (column: string, limit = 8, entriesOnly = false) =>
    db
      .prepare(
        `SELECT ${column} AS key,
                COUNT(DISTINCT visitor_hash) AS visitors,
                COUNT(*) AS views
         FROM visits
         WHERE website_id = ? AND occurred_at >= ?
           ${entriesOnly ? "AND is_entry = 1" : ""}
         GROUP BY ${column} ORDER BY views DESC LIMIT ?`,
      )
      .all(websiteId, from, limit) as unknown as {
      key: string | null;
      visitors: number;
      views: number;
    }[];

  const topPages = db
    .prepare(
      `SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor_hash) AS visitors
       FROM visits WHERE website_id = ? AND occurred_at >= ?
       GROUP BY path ORDER BY views DESC LIMIT 10`,
    )
    .all(websiteId, from) as unknown as {
    path: string;
    views: number;
    visitors: number;
  }[];

  const hours = db
    .prepare(
      `SELECT substr(occurred_at, 12, 2) AS hour, COUNT(*) AS views
       FROM visits WHERE website_id = ? AND occurred_at >= ?
       GROUP BY hour ORDER BY hour ASC`,
    )
    .all(websiteId, from) as unknown as { hour: string; views: number }[];

  // Joins visits back to the post that produced them, which is the whole point
  // of tagging published links.
  const attributed = db
    .prepare(
      `SELECT v.content_item_id AS content_item_id,
              c.channel AS channel,
              c.pillar AS pillar,
              COALESCE(c.subject, c.body) AS excerpt,
              COUNT(*) AS visits,
              COALESCE(SUM(v.is_goal), 0) AS goals
       FROM visits v
       JOIN content_items c ON c.id = v.content_item_id
       WHERE v.website_id = ? AND v.occurred_at >= ?
         AND v.content_item_id IS NOT NULL
       GROUP BY v.content_item_id
       ORDER BY visits DESC LIMIT 10`,
    )
    .all(websiteId, from) as unknown as {
    content_item_id: string;
    channel: string;
    pillar: string;
    excerpt: string;
    visits: number;
    goals: number;
  }[];

  const entryViews = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM visits
       WHERE website_id = ? AND occurred_at >= ? AND is_entry = 1
         AND (referrer_source IS NULL OR referrer_source NOT LIKE 'internal%')`,
    )
    .get(websiteId, from) as unknown as { n: number }).n;

  const sourceLabel = (key: string) => {
    const [kind, host] = key.split(":");
    if (!host) {
      return kind === "direct"
        ? "Direct / none"
        : (kind ?? "").charAt(0).toUpperCase() + (kind ?? "").slice(1);
    }
    return host;
  };

  return {
    window_days: windowDays,
    totals: {
      views: totals.views,
      visitors: totals.visitors,
      sessions: totals.sessions,
      goals: totals.goals,
      bounce_rate:
        totals.sessions > 0 ? bounce.bounced / totals.sessions : 0,
      avg_session_seconds: Math.round((dwell.avg_ms ?? 0) / 1000),
      pages_per_session:
        totals.sessions > 0 ? totals.views / totals.sessions : 0,
    },
    daily,
    countries: toBreakdown(groupBy("country"), totals.views, countryName),
    regions: toBreakdown(groupBy("region"), totals.views),
    devices: toBreakdown(groupBy("device", 4), totals.views, (d) =>
      d.charAt(0).toUpperCase() + d.slice(1),
    ),
    browsers: toBreakdown(groupBy("browser", 6), totals.views),
    // Arrival source is measured over entry visits, not every pageview, so
    // moving between pages does not register as a referral from yourself.
    sources: toBreakdown(
      groupBy("referrer_source", 8, true).filter(
        (r) => !(r.key ?? "").startsWith("internal"),
      ),
      entryViews,
      sourceLabel,
    ),
    top_pages: topPages,
    hours,
    attributed: attributed.map((a) => ({
      ...a,
      excerpt: (a.excerpt ?? "").replace(/\s+/g, " ").slice(0, 80),
    })),
  };
}

export function buildSiteHealth(websiteId: string): SiteHealth {
  const checks = recentChecks(websiteId, 60);
  const latest: HealthCheckRow | undefined = checks[0];
  const day = uptimeSince(websiteId, since(1));
  const month = uptimeSince(websiteId, since(30));
  const incidents = listIncidents(websiteId, 10);

  const verdict = latest?.verdict ?? "unknown";

  return {
    verdict,
    description:
      latest === undefined
        ? "Not checked yet"
        : describeVerdict(latest.verdict as never),
    last_checked: latest?.checked_at ?? null,
    response_ms: latest?.response_ms ?? null,
    ssl_days_left: latest?.ssl_days_left ?? null,
    uptime_24h: day.total > 0 ? day.ok / day.total : null,
    uptime_30d: month.total > 0 ? month.ok / month.total : null,
    avg_response_ms: month.avg_ms === null ? null : Math.round(month.avg_ms),
    checks_24h: day.total,
    open_incident: incidents.find((i) => i.resolved_at === null) ?? null,
    incidents,
    recent: checks
      .slice(0, 48)
      .reverse()
      .map((c) => ({
        at: c.checked_at,
        ok: c.ok === 1,
        ms: c.response_ms,
        verdict: c.verdict,
      })),
  };
}

export function buildWebsiteOverview(businessId: string): WebsiteOverview {
  const website = websiteForBusiness(businessId);
  if (!website) {
    return { website: null, health: null, audience: null, content: null };
  }

  const pages = listPages(website.id, 100);
  const issueCounts = new Map<string, number>();
  let pagesWithIssues = 0;
  for (const page of pages) {
    const issues: string[] = JSON.parse(page.issues);
    if (issues.length > 0) pagesWithIssues += 1;
    for (const issue of issues) {
      // Collapse counted variants ("3 images missing alt text") into one row.
      const normalised = issue.replace(/^\d+\s+/, "").replace(/^image\b/, "images");
      issueCounts.set(normalised, (issueCounts.get(normalised) ?? 0) + 1);
    }
  }

  return {
    website,
    health: buildSiteHealth(website.id),
    audience: buildAudienceStats(website.id),
    content: {
      pages: pages.slice(0, 25),
      total_pages: pages.length,
      pages_with_issues: pagesWithIssues,
      top_issues: [...issueCounts.entries()]
        .map(([issue, count]) => ({ issue, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
    },
  };
}
