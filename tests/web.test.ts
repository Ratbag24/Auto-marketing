import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isPrivateAddress, parseSiteUrl, assertFetchable } from "../src/web/url-guard.js";
import { extract, findIssues, isAllowedByRobots } from "../src/web/html.js";
import {
  classifyReferrer,
  contentItemFromCampaign,
  campaignTag,
  countryFromHeaders,
  countryFromTimezone,
  parseUserAgent,
  regionFromTimezone,
  visitorHash,
  setSaltForTesting,
} from "../src/web/analytics.js";
import { tagLinks } from "../src/engine/attribution.js";
import type { ContentItem } from "../src/db/types.js";
import type { Website } from "../src/db/websites.js";

describe("SSRF guard", () => {
  // This server fetches URLs a user typed in. Each of these, if allowed,
  // turns the crawler into a window onto the internal network.
  for (const ip of [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.4.2",
    "172.31.255.255",
    "169.254.169.254", // cloud instance metadata
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "224.0.0.1",
  ]) {
    test(`treats ${ip} as private`, () => {
      assert.equal(isPrivateAddress(ip), true);
    });
  }

  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"]) {
    test(`treats ${ip} as public`, () => {
      assert.equal(isPrivateAddress(ip), false);
    });
  }

  test("rejects a non-http scheme", () => {
    const result = parseSiteUrl("file:///etc/passwd");
    assert.equal(result.ok, false);
  });

  test("rejects localhost", () => {
    assert.equal(parseSiteUrl("http://localhost:8787").ok, false);
  });

  test("rejects embedded credentials", () => {
    assert.equal(parseSiteUrl("https://user:pass@example.com").ok, false);
  });

  test("rejects a hostname with no dot", () => {
    assert.equal(parseSiteUrl("http://internal-box").ok, false);
  });

  test("accepts a bare domain and assumes https", () => {
    const result = parseSiteUrl("example.com");
    assert.equal(result.ok, true);
    assert.equal(result.url?.protocol, "https:");
  });

  test("refuses a literal private IP in the URL", async () => {
    const result = await assertFetchable("http://192.168.0.1/admin");
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /private/);
  });
});

describe("HTML extraction", () => {
  const html = `<!doctype html><html><head>
    <title>Northgate Dental &mdash; Evening appointments</title>
    <meta name="description" content="Evening and Saturday dental appointments.">
    <meta name="viewport" content="width=device-width">
    <link rel="canonical" href="https://example.com/">
    <style>.x{color:red}</style>
  </head><body>
    <h1>Dentistry that fits around work</h1>
    <p>We open until 8pm on weekdays and all day Saturday.</p>
    <script>var tracking = "should not appear";</script>
    <img src="a.png" alt="Our practice"><img src="b.png">
    <a href="/prices">Prices</a>
    <a href="https://other.example.org/x">External</a>
    <a href="mailto:hi@example.com">Mail</a>
    <a href="#top">Anchor</a>
  </body></html>`;

  const page = extract(html, "https://example.com/");

  test("decodes entities in the title", () => {
    assert.equal(page.title, "Northgate Dental — Evening appointments");
  });

  test("reads the meta description", () => {
    assert.equal(page.metaDescription, "Evening and Saturday dental appointments.");
  });

  test("reads the first h1", () => {
    assert.equal(page.h1, "Dentistry that fits around work");
  });

  test("excludes script and style content from the text", () => {
    assert.ok(!page.text.includes("should not appear"));
    assert.ok(!page.text.includes("color:red"));
    assert.ok(page.text.includes("open until 8pm"));
  });

  test("resolves relative links and skips mailto and anchors", () => {
    assert.ok(page.links.includes("https://example.com/prices"));
    assert.ok(page.links.includes("https://other.example.org/x"));
    assert.ok(!page.links.some((l) => l.startsWith("mailto")));
    assert.equal(page.links.length, 2);
  });

  test("counts images missing alt text", () => {
    assert.equal(page.imageCount, 2);
    assert.equal(page.imagesMissingAlt, 1);
  });

  test("flags the missing alt text as an issue", () => {
    const issues = findIssues(page, 200);
    assert.ok(issues.some((i) => /missing alt text/.test(i)));
  });

  test("reports an error status as the only issue", () => {
    assert.deepEqual(findIssues(page, 404), ["Returns HTTP 404"]);
  });

  test("flags a page with no title or description", () => {
    const bare = extract("<html><body><p>hi</p></body></html>", "https://e.com/");
    const issues = findIssues(bare, 200);
    assert.ok(issues.includes("No page title"));
    assert.ok(issues.includes("No meta description"));
    assert.ok(issues.includes("No H1 heading"));
    assert.ok(issues.includes("No mobile viewport tag"));
  });
});

describe("robots.txt", () => {
  const robots = `User-agent: *\nDisallow: /admin\nDisallow: /cart\nAllow: /admin/public\n`;

  test("allows an ordinary path", () => {
    assert.equal(isAllowedByRobots(robots, "/prices"), true);
  });

  test("respects a disallow rule", () => {
    assert.equal(isAllowedByRobots(robots, "/admin/settings"), false);
  });

  test("a longer allow rule beats a shorter disallow", () => {
    assert.equal(isAllowedByRobots(robots, "/admin/public/page"), true);
  });

  test("an empty robots.txt allows everything", () => {
    assert.equal(isAllowedByRobots("", "/anything"), true);
  });

  test("a rule naming our agent overrides the wildcard group", () => {
    const specific =
      `User-agent: *\nDisallow: /\n\nUser-agent: automarketingbot\nDisallow: /private\n`;
    assert.equal(isAllowedByRobots(specific, "/prices"), true);
    assert.equal(isAllowedByRobots(specific, "/private/x"), false);
  });
});

describe("visitor privacy", () => {
  test("the same visitor hashes consistently within a day", () => {
    setSaltForTesting("fixed-salt");
    const a = visitorHash("site_1", "203.0.113.9", "Mozilla/5.0");
    const b = visitorHash("site_1", "203.0.113.9", "Mozilla/5.0");
    assert.equal(a, b);
  });

  test("the hash does not contain the IP address", () => {
    setSaltForTesting("fixed-salt");
    const hash = visitorHash("site_1", "203.0.113.9", "Mozilla/5.0");
    assert.ok(!hash.includes("203"));
    assert.match(hash, /^[0-9a-f]{32}$/);
  });

  test("a different salt gives a different hash, so days cannot be linked", () => {
    setSaltForTesting("monday");
    const monday = visitorHash("site_1", "203.0.113.9", "UA");
    setSaltForTesting("tuesday");
    const tuesday = visitorHash("site_1", "203.0.113.9", "UA");
    assert.notEqual(monday, tuesday);
  });

  test("visitors are not shared across sites", () => {
    setSaltForTesting("fixed-salt");
    assert.notEqual(
      visitorHash("site_1", "203.0.113.9", "UA"),
      visitorHash("site_2", "203.0.113.9", "UA"),
    );
  });
});

describe("audience parsing", () => {
  test("identifies mobile, tablet and desktop", () => {
    assert.equal(
      parseUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari").device,
      "mobile",
    );
    assert.equal(
      parseUserAgent("Mozilla/5.0 (iPad; CPU OS 17_0) Safari").device,
      "tablet",
    );
    assert.equal(
      parseUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64) Chrome/120").device,
      "desktop",
    );
  });

  test("identifies bots so they never reach the stats", () => {
    assert.equal(parseUserAgent("Googlebot/2.1").device, "bot");
    assert.equal(parseUserAgent("curl/8.0").device, "bot");
    assert.equal(parseUserAgent("HeadlessChrome/120").device, "bot");
  });

  test("does not mistake Edge or Opera for Chrome", () => {
    assert.equal(parseUserAgent("Chrome/120 Edg/120").browser, "Edge");
    assert.equal(parseUserAgent("Chrome/120 OPR/106").browser, "Opera");
    assert.equal(parseUserAgent("Mozilla/5.0 Chrome/120 Safari").browser, "Chrome");
  });

  test("reads country from whichever proxy header is present", () => {
    assert.equal(countryFromHeaders({ "cf-ipcountry": "GB" }), "GB");
    assert.equal(countryFromHeaders({ "x-vercel-ip-country": "us" }), "US");
    assert.equal(countryFromHeaders({ "cloudfront-viewer-country": "DE" }), "DE");
    assert.equal(countryFromHeaders({}), null);
    // Cloudflare uses XX for unknown; that is not a country.
    assert.equal(countryFromHeaders({ "cf-ipcountry": "XX" }), null);
  });

  test("falls back to timezone for country and region", () => {
    assert.equal(countryFromTimezone("Europe/London"), "GB");
    assert.equal(regionFromTimezone("Europe/London"), "Europe");
    assert.equal(regionFromTimezone("America/New_York"), "Americas");
    // An unmapped zone stays unknown rather than being guessed.
    assert.equal(countryFromTimezone("Europe/Vatican"), null);
    assert.equal(regionFromTimezone(null), null);
  });

  test("classifies referrers into actionable sources", () => {
    const site = "https://example.com";
    assert.equal(classifyReferrer(null, site).source, "direct");
    assert.equal(classifyReferrer("https://www.google.com/", site).source, "search");
    assert.equal(classifyReferrer("https://t.co/abc", site).source, "social");
    assert.equal(classifyReferrer("https://linkedin.com/feed", site).source, "social");
    assert.equal(classifyReferrer("https://example.com/about", site).source, "internal");
    assert.equal(classifyReferrer("https://someblog.net/x", site).source, "referral");
  });
});

describe("attribution", () => {
  const item = { id: "item_abc123", channel: "x" } as ContentItem;
  const site = { url: "https://northgate.example" } as Website;

  test("round-trips a campaign tag", () => {
    assert.equal(contentItemFromCampaign(campaignTag("item_x")), "item_x");
    assert.equal(contentItemFromCampaign("other_campaign"), null);
    assert.equal(contentItemFromCampaign(null), null);
  });

  test("tags a link to the business's own site", () => {
    const out = tagLinks("Book at https://northgate.example/book now", item, site);
    assert.match(out, /utm_campaign=am_item_abc123/);
    assert.match(out, /utm_source=x/);
    assert.ok(out.includes("/book"));
  });

  test("leaves third-party links untouched", () => {
    const body = "Read more at https://bbc.co.uk/news today";
    assert.equal(tagLinks(body, item, site), body);
  });

  test("keeps sentence punctuation outside the URL", () => {
    const out = tagLinks("Visit northgate.example.", item, site);
    assert.ok(out.endsWith("."), "the sentence should still end with a full stop");

    // The campaign value itself must not have swallowed the punctuation,
    // which would break the lookup back to the content item.
    const url = new URL(out.slice("Visit ".length, -1));
    assert.equal(url.searchParams.get("utm_campaign"), "am_item_abc123");
  });

  test("does not double-tag an already tagged link", () => {
    const once = tagLinks("Go to https://northgate.example/x", item, site);
    const twice = tagLinks(once, item, site);
    assert.equal(once, twice);
  });

  test("leaves copy with no links alone", () => {
    const body = "We now open on Saturdays.";
    assert.equal(tagLinks(body, item, site), body);
  });
});
