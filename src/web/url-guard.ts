import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Guards every outbound fetch to a user-supplied address.
 *
 * A business can type any URL into the dashboard, and this server will then
 * fetch it. Without this check that is a server-side request forgery hole: a
 * URL pointing at 127.0.0.1, 169.254.169.254 (cloud metadata) or an internal
 * 10.x host would have this process read it and show the contents back.
 *
 * DNS is resolved and the resulting address checked, because a public hostname
 * can legitimately resolve to a private address.
 */

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;                      // 10.0.0.0/8
  if (a === 127) return true;                     // loopback
  if (a === 0) return true;                       // "this network"
  if (a === 169 && b === 254) return true;        // link-local + metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true;                      // multicast + reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0] ?? "";
  if (addr === "::1" || addr === "::") return true;
  if (addr.startsWith("fe80")) return true;       // link-local
  if (/^f[cd]/.test(addr)) return true;           // unique local fc00::/7
  // IPv4-mapped, e.g. ::ffff:127.0.0.1
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped?.[1]) return isPrivateIPv4(mapped[1]);
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not an address we recognise - refuse
}

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  url?: URL;
}

/** Parses and normalises a site URL without touching the network. */
export function parseSiteUrl(raw: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Accept a bare domain by assuming https.
    try {
      url = new URL(`https://${raw.trim()}`);
    } catch {
      return { ok: false, reason: "That does not look like a URL." };
    }
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Only http and https addresses are supported." };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with embedded credentials are not allowed." };
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    return { ok: false, reason: "Local addresses cannot be monitored." };
  }
  if (!url.hostname.includes(".")) {
    return { ok: false, reason: "That hostname has no public domain." };
  }

  return { ok: true, url };
}

/** Full check: parse, then confirm the host resolves to a public address. */
export async function assertFetchable(raw: string): Promise<UrlCheck> {
  const parsed = parseSiteUrl(raw);
  if (!parsed.ok || !parsed.url) return parsed;

  const host = parsed.url.hostname;

  // A literal IP in the URL is checked directly; no DNS needed.
  if (isIP(host)) {
    return isPrivateAddress(host)
      ? { ok: false, reason: "That address is on a private network." }
      : parsed;
  }

  try {
    const addresses = await lookup(host, { all: true });
    if (addresses.length === 0) {
      return { ok: false, reason: `${host} does not resolve.` };
    }
    // Every resolved address must be public: one private answer is enough to
    // reach an internal host.
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        return { ok: false, reason: `${host} resolves to a private address.` };
      }
    }
    return parsed;
  } catch {
    return { ok: false, reason: `${host} could not be resolved.` };
  }
}

/**
 * fetch() that re-checks the destination on every redirect hop, since a public
 * URL can redirect to a private one.
 */
export async function safeFetch(
  target: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 10_000, ...rest } = init;
  let current = target;

  for (let hop = 0; hop < 5; hop += 1) {
    const check = await assertFetchable(current);
    if (!check.ok || !check.url) {
      throw new Error(check.reason ?? "Address refused");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(check.url, {
        ...rest,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "AutoMarketingBot/1.0 (+site monitoring; respects robots.txt)",
          ...(rest.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      current = new URL(location, check.url).toString();
      continue;
    }

    return response;
  }

  throw new Error("Too many redirects");
}
