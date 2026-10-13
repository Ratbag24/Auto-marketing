/**
 * Minimal HTML extraction.
 *
 * A full DOM parser would be a heavy dependency for what is needed here:
 * title, meta description, first h1, visible text and links. These regexes are
 * tolerant of malformed markup and never execute anything.
 */

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘",
    ldquo: "“", rdquo: "”", copy: "©", trade: "™", reg: "®",
  };
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16)),
    )
    .replace(/&([a-zA-Z]+);/g, (whole, name) => named[name] ?? whole);
}

const squash = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

function firstMatch(html: string, pattern: RegExp): string | null {
  const m = pattern.exec(html);
  return m?.[1] ? squash(m[1]) : null;
}

export interface ExtractedPage {
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  text: string;
  wordCount: number;
  links: string[];
  hasViewport: boolean;
  hasCanonical: boolean;
  imageCount: number;
  imagesMissingAlt: number;
}

export function extract(html: string, baseUrl: string): ExtractedPage {
  // Strip anything that is not visible prose before counting words.
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const text = squash(stripped.replace(/<[^>]+>/g, " "));

  const links: string[] = [];
  const linkPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkPattern.exec(html)) !== null) {
    const href = match[1];
    if (!href) continue;
    if (/^(mailto:|tel:|javascript:|#|data:)/i.test(href.trim())) continue;
    try {
      const resolved = new URL(href, baseUrl);
      resolved.hash = "";
      links.push(resolved.toString());
    } catch {
      /* unparseable href - ignore */
    }
  }

  const images = html.match(/<img\b[^>]*>/gi) ?? [];
  const missingAlt = images.filter(
    (tag) => !/\balt\s*=\s*["'][^"']*\S/i.test(tag),
  ).length;

  return {
    title: firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    metaDescription:
      firstMatch(
        html,
        /<meta[^>]+name\s*=\s*["']description["'][^>]*\bcontent\s*=\s*["']([^"']*)["']/i,
      ) ??
      firstMatch(
        html,
        /<meta[^>]+\bcontent\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i,
      ),
    h1: firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i),
    text: text.slice(0, 20_000),
    wordCount: text === "" ? 0 : text.split(/\s+/).length,
    links: [...new Set(links)],
    hasViewport: /<meta[^>]+name\s*=\s*["']viewport["']/i.test(html),
    hasCanonical: /<link[^>]+rel\s*=\s*["']canonical["']/i.test(html),
    imageCount: images.length,
    imagesMissingAlt: missingAlt,
  };
}

/** The SEO and quality problems worth telling a business owner about. */
export function findIssues(page: ExtractedPage, statusCode: number): string[] {
  const issues: string[] = [];

  if (statusCode >= 400) {
    issues.push(`Returns HTTP ${statusCode}`);
    return issues;
  }

  if (!page.title) issues.push("No page title");
  else if (page.title.length < 15) issues.push("Page title is very short");
  else if (page.title.length > 60)
    issues.push("Page title is too long for search results");

  if (!page.metaDescription) issues.push("No meta description");
  else if (page.metaDescription.length > 160)
    issues.push("Meta description is too long for search results");

  if (!page.h1) issues.push("No H1 heading");
  if (page.wordCount < 100) issues.push("Very little text on the page");
  if (!page.hasViewport) issues.push("No mobile viewport tag");
  if (page.imagesMissingAlt > 0) {
    issues.push(
      `${page.imagesMissingAlt} image${page.imagesMissingAlt === 1 ? "" : "s"} missing alt text`,
    );
  }

  return issues;
}

/** Just enough robots.txt to be a polite crawler. */
export function isAllowedByRobots(
  robotsTxt: string,
  path: string,
  agent = "automarketingbot",
): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());

  let applies = false;
  let sawMatchingGroup = false;
  const disallowed: string[] = [];
  const allowed: string[] = [];

  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      const ua = value.toLowerCase();
      // A group for our agent wins over the wildcard group.
      if (ua === agent) {
        applies = true;
        sawMatchingGroup = true;
        disallowed.length = 0;
        allowed.length = 0;
      } else if (ua === "*" && !sawMatchingGroup) {
        applies = true;
      } else {
        applies = false;
      }
      continue;
    }

    if (!applies) continue;
    if (key === "disallow" && value !== "") disallowed.push(value);
    if (key === "allow" && value !== "") allowed.push(value);
  }

  // Longest matching rule wins; Allow beats Disallow at equal length.
  const longest = (rules: string[]) =>
    rules.filter((r) => path.startsWith(r)).reduce((a, b) => (b.length > a.length ? b : a), "");

  const deny = longest(disallowed);
  const permit = longest(allowed);
  if (deny === "") return true;
  return permit.length >= deny.length;
}
