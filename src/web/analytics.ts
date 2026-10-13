import { createHash, randomBytes } from "node:crypto";

/**
 * Visitor identification without storing anything that identifies a person.
 *
 * The hash is salted with a secret that rotates every day, so the same visitor
 * produces a different hash tomorrow. That is enough to count daily uniques and
 * sessions, and makes it impossible to follow anyone across days or to recover
 * an IP address from what is stored. No IP is ever written to the database.
 */

let salt = randomBytes(32).toString("hex");
let saltDay = new Date().toISOString().slice(0, 10);

function currentSalt(): string {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== saltDay) {
    salt = randomBytes(32).toString("hex");
    saltDay = today;
  }
  return salt;
}

export function visitorHash(
  websiteId: string,
  ip: string,
  userAgent: string,
): string {
  return createHash("sha256")
    .update(`${currentSalt()}:${websiteId}:${ip}:${userAgent}`)
    .digest("hex")
    .slice(0, 32);
}

/** Test seam: force a known salt so hashing is deterministic. */
export function setSaltForTesting(value: string): void {
  salt = value;
  saltDay = new Date().toISOString().slice(0, 10);
}

// --------------------------------------------------------------------------
// Where the visitor is
// --------------------------------------------------------------------------

/**
 * Country is read from whichever edge proxy sits in front of this server.
 * None of the common hosts agree on a header name, so all the usual ones are
 * checked. If none is present the browser's own timezone gives a coarse
 * region, which costs nothing and needs no IP lookup.
 */
export function countryFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const candidates = [
    "cf-ipcountry",            // Cloudflare
    "x-vercel-ip-country",     // Vercel
    "fastly-geo-country",      // Fastly
    "x-geo-country",
    "x-country-code",
    "cloudfront-viewer-country", // AWS CloudFront
  ];
  for (const name of candidates) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value && /^[A-Za-z]{2}$/.test(value) && value.toUpperCase() !== "XX") {
      return value.toUpperCase();
    }
  }
  return null;
}

/** Maps an IANA timezone to a coarse region, e.g. "Europe/London" -> "Europe". */
export function regionFromTimezone(tz: string | null): string | null {
  if (!tz || !tz.includes("/")) return null;
  const area = tz.split("/")[0] ?? "";
  const known: Record<string, string> = {
    Europe: "Europe",
    America: "Americas",
    Asia: "Asia",
    Africa: "Africa",
    Australia: "Oceania",
    Pacific: "Oceania",
    Indian: "Asia",
    Atlantic: "Europe",
    Antarctica: "Antarctica",
  };
  return known[area] ?? null;
}

/**
 * A rough country guess from the timezone, for visitors not behind a geo-aware
 * proxy. Only unambiguous zones are mapped; anything else stays unknown rather
 * than being guessed wrongly.
 */
const TZ_COUNTRY: Record<string, string> = {
  "Europe/London": "GB",
  "Europe/Dublin": "IE",
  "Europe/Paris": "FR",
  "Europe/Berlin": "DE",
  "Europe/Madrid": "ES",
  "Europe/Rome": "IT",
  "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE",
  "Europe/Lisbon": "PT",
  "Europe/Vienna": "AT",
  "Europe/Zurich": "CH",
  "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO",
  "Europe/Copenhagen": "DK",
  "Europe/Helsinki": "FI",
  "Europe/Warsaw": "PL",
  "Europe/Prague": "CZ",
  "Europe/Athens": "GR",
  "Europe/Moscow": "RU",
  "Europe/Kyiv": "UA",
  "America/New_York": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Los_Angeles": "US",
  "America/Phoenix": "US",
  "America/Anchorage": "US",
  "America/Toronto": "CA",
  "America/Vancouver": "CA",
  "America/Edmonton": "CA",
  "America/Winnipeg": "CA",
  "America/Mexico_City": "MX",
  "America/Sao_Paulo": "BR",
  "America/Buenos_Aires": "AR",
  "America/Argentina/Buenos_Aires": "AR",
  "America/Bogota": "CO",
  "America/Santiago": "CL",
  "America/Lima": "PE",
  "Asia/Tokyo": "JP",
  "Asia/Seoul": "KR",
  "Asia/Shanghai": "CN",
  "Asia/Hong_Kong": "HK",
  "Asia/Singapore": "SG",
  "Asia/Kolkata": "IN",
  "Asia/Calcutta": "IN",
  "Asia/Dubai": "AE",
  "Asia/Jakarta": "ID",
  "Asia/Manila": "PH",
  "Asia/Bangkok": "TH",
  "Asia/Jerusalem": "IL",
  "Asia/Riyadh": "SA",
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Brisbane": "AU",
  "Australia/Perth": "AU",
  "Pacific/Auckland": "NZ",
  "Africa/Johannesburg": "ZA",
  "Africa/Lagos": "NG",
  "Africa/Cairo": "EG",
  "Africa/Nairobi": "KE",
};

export function countryFromTimezone(tz: string | null): string | null {
  if (!tz) return null;
  return TZ_COUNTRY[tz] ?? null;
}

// --------------------------------------------------------------------------
// Who the visitor is (device, not identity)
// --------------------------------------------------------------------------

export interface Agent {
  device: "mobile" | "tablet" | "desktop" | "bot";
  browser: string;
  os: string;
}

export function parseUserAgent(ua: string): Agent {
  const s = ua.toLowerCase();

  if (/bot|crawler|spider|crawling|headless|preview|monitor|curl|wget/.test(s)) {
    return { device: "bot", browser: "Bot", os: "Bot" };
  }

  const device: Agent["device"] = /ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(s)
    ? "tablet"
    : /mobi|iphone|ipod|android|blackberry|windows phone/.test(s)
      ? "mobile"
      : "desktop";

  // Order matters: several browsers impersonate the ones below them.
  const browser = /edg\//.test(s)
    ? "Edge"
    : /opr\/|opera/.test(s)
      ? "Opera"
      : /samsungbrowser/.test(s)
        ? "Samsung Internet"
        : /firefox|fxios/.test(s)
          ? "Firefox"
          : /chrome|crios/.test(s)
            ? "Chrome"
            : /safari/.test(s)
              ? "Safari"
              : "Other";

  const os = /windows/.test(s)
    ? "Windows"
    : /iphone|ipad|ipod|ios/.test(s)
      ? "iOS"
      : /mac os x|macintosh/.test(s)
        ? "macOS"
        : /android/.test(s)
          ? "Android"
          : /linux/.test(s)
            ? "Linux"
            : "Other";

  return { device, browser, os };
}

// --------------------------------------------------------------------------
// Where the visitor came from
// --------------------------------------------------------------------------

const SEARCH = /google|bing|duckduckgo|yahoo|ecosia|baidu|yandex|brave/;
const SOCIAL =
  /facebook|instagram|twitter|t\.co|x\.com|linkedin|lnkd\.in|reddit|pinterest|tiktok|youtube|threads|mastodon|whatsapp/;

/** Classifies a referrer into something a business owner can act on. */
export function classifyReferrer(
  referrer: string | null,
  siteOrigin: string,
): { source: string; host: string | null } {
  if (!referrer || referrer.trim() === "") {
    return { source: "direct", host: null };
  }
  let host: string;
  try {
    const url = new URL(referrer);
    host = url.hostname.replace(/^www\./, "");
    if (referrer.startsWith(siteOrigin)) {
      return { source: "internal", host };
    }
  } catch {
    return { source: "direct", host: null };
  }

  if (SEARCH.test(host)) return { source: "search", host };
  if (SOCIAL.test(host)) return { source: "social", host };
  return { source: "referral", host };
}

/**
 * The UTM tag appended to links in published posts, so a visit can be traced
 * back to the exact piece of content that produced it.
 */
export function campaignTag(contentItemId: string): string {
  return `am_${contentItemId}`;
}

export function contentItemFromCampaign(tag: string | null): string | null {
  if (!tag) return null;
  return tag.startsWith("am_") ? tag.slice(3) : null;
}
