import { extract, findIssues, isAllowedByRobots } from "./html.js";
import { safeFetch, parseSiteUrl } from "./url-guard.js";
import { logEvent, nowIso } from "../db/index.js";
import { savePage, touchCrawl, type Website } from "../db/websites.js";

export interface CrawlResult {
  pagesCrawled: number;
  issuesFound: number;
  skipped: string[];
}

/** Keeps a crawl small enough to stay polite and cheap. */
const MAX_PAGES = 40;
const MAX_DEPTH = 3;
const DELAY_MS = 350;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Obvious non-content URLs; crawling them wastes requests. */
const SKIP_EXTENSIONS =
  /\.(pdf|zip|png|jpe?g|gif|svg|webp|avif|ico|css|js|mp4|mp3|wav|woff2?|ttf|eot|xml|json|rss)(\?|$)/i;

export async function crawlWebsite(site: Website): Promise<CrawlResult> {
  const parsed = parseSiteUrl(site.url);
  if (!parsed.ok || !parsed.url) {
    throw new Error(parsed.reason ?? "Invalid site URL");
  }
  const origin = parsed.url.origin;

  // Fetch robots.txt first. If it is unreachable, assume crawling is allowed -
  // that is the convention - but still honour it when present.
  let robots = "";
  try {
    const res = await safeFetch(`${origin}/robots.txt`, { timeoutMs: 6000 });
    if (res.ok) robots = (await res.text()).slice(0, 100_000);
  } catch {
    /* no robots.txt - proceed */
  }

  const queue: { url: string; depth: number }[] = [
    { url: parsed.url.toString(), depth: 0 },
  ];
  const seen = new Set<string>([parsed.url.toString()]);
  const skipped: string[] = [];
  let crawled = 0;
  let issuesFound = 0;

  while (queue.length > 0 && crawled < MAX_PAGES) {
    const next = queue.shift();
    if (!next) break;

    const { url, depth } = next;
    const path = new URL(url).pathname;

    if (!isAllowedByRobots(robots, path)) {
      skipped.push(`${path} (robots.txt)`);
      continue;
    }

    try {
      const started = Date.now();
      const response = await safeFetch(url, { timeoutMs: 12_000 });
      const elapsed = Date.now() - started;

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        skipped.push(`${path} (${contentType.split(";")[0] || "not html"})`);
        continue;
      }

      const html = (await response.text()).slice(0, 1_500_000);
      const page = extract(html, url);
      const issues = findIssues(page, response.status);
      issuesFound += issues.length;

      savePage({
        website_id: site.id,
        url,
        path,
        title: page.title,
        meta_description: page.metaDescription,
        h1: page.h1,
        excerpt: page.text.slice(0, 600),
        word_count: page.wordCount,
        status_code: response.status,
        internal_links: page.links.filter((l) => l.startsWith(origin)).length,
        external_links: page.links.filter((l) => !l.startsWith(origin)).length,
        issues,
      });
      crawled += 1;

      if (depth < MAX_DEPTH) {
        for (const link of page.links) {
          if (!link.startsWith(origin)) continue;       // same origin only
          if (SKIP_EXTENSIONS.test(link)) continue;
          if (seen.has(link)) continue;
          if (seen.size >= MAX_PAGES * 3) break;        // bound the frontier
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
        }
      }

      // Be a polite guest: never hammer a small business's server.
      if (queue.length > 0) await sleep(Math.max(DELAY_MS, elapsed));
    } catch (err) {
      skipped.push(`${path} (${err instanceof Error ? err.message : "failed"})`);
    }
  }

  touchCrawl(site.id, nowIso());

  logEvent("site.crawled", `Crawled ${crawled} pages of ${site.url}`, {
    businessId: site.business_id,
    level: issuesFound > 0 ? "warn" : "info",
    data: { pages: crawled, issues: issuesFound, skipped: skipped.length },
  });

  return { pagesCrawled: crawled, issuesFound, skipped };
}
