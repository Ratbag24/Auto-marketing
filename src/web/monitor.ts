import { connect, type TLSSocket } from "node:tls";
import { safeFetch, parseSiteUrl } from "./url-guard.js";
import { logEvent } from "../db/index.js";
import {
  bumpIncident,
  listMonitoredWebsites,
  openIncident,
  recentChecks,
  recordHealthCheck,
  resolveIncident,
  startIncident,
  type Verdict,
  type Website,
} from "../db/websites.js";

/** Above this, a site is up but visibly sluggish. */
const SLOW_MS = 3000;
/** Consecutive failures before an incident is declared, to absorb blips. */
const FAILURES_BEFORE_INCIDENT = 2;
/** Warn this far ahead of certificate expiry. */
const CERT_WARN_DAYS = 14;

export interface CheckOutcome {
  ok: boolean;
  verdict: Verdict;
  statusCode: number | null;
  responseMs: number | null;
  sslDaysLeft: number | null;
  error: string | null;
}

/**
 * Reads the TLS certificate expiry without issuing a request.
 *
 * An expired certificate makes a site unreachable for most visitors while it
 * may still answer fine from a script, so it is worth checking separately.
 */
export function certificateDaysLeft(
  hostname: string,
  port = 443,
  timeoutMs = 6000,
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: number | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let socket: TLSSocket;
    try {
      socket = connect({ host: hostname, port, servername: hostname, timeout: timeoutMs });
    } catch {
      done(null);
      return;
    }

    socket.on("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) {
        done(null);
        return;
      }
      const expiry = new Date(cert.valid_to).getTime();
      if (Number.isNaN(expiry)) {
        done(null);
        return;
      }
      done(Math.floor((expiry - Date.now()) / 86_400_000));
    });

    socket.on("timeout", () => {
      socket.destroy();
      done(null);
    });
    socket.on("error", () => {
      socket.destroy();
      done(null);
    });
  });
}

/** Runs one check against one site and classifies the result. */
export async function checkWebsite(site: Website): Promise<CheckOutcome> {
  const parsed = parseSiteUrl(site.url);
  if (!parsed.ok || !parsed.url) {
    return {
      ok: false,
      verdict: "broken",
      statusCode: null,
      responseMs: null,
      sslDaysLeft: null,
      error: parsed.reason ?? "Invalid URL",
    };
  }

  const url = parsed.url;
  let sslDaysLeft: number | null = null;
  if (url.protocol === "https:") {
    sslDaysLeft = await certificateDaysLeft(
      url.hostname,
      url.port ? Number(url.port) : 443,
    );
  }

  const started = Date.now();
  try {
    const response = await safeFetch(url.toString(), { timeoutMs: 15_000 });
    const responseMs = Date.now() - started;
    const body = (await response.text()).slice(0, 500_000);

    if (response.status >= 500) {
      return {
        ok: false,
        verdict: "down",
        statusCode: response.status,
        responseMs,
        sslDaysLeft,
        error: `Server error ${response.status}`,
      };
    }
    if (response.status >= 400) {
      return {
        ok: false,
        verdict: "broken",
        statusCode: response.status,
        responseMs,
        sslDaysLeft,
        error: `Returned ${response.status}`,
      };
    }

    // A 200 that no longer contains the expected text usually means a broken
    // deploy or an empty render - worse than a clean error, because nothing
    // else would notice.
    if (site.expected_text && !body.includes(site.expected_text)) {
      return {
        ok: false,
        verdict: "content_missing",
        statusCode: response.status,
        responseMs,
        sslDaysLeft,
        error: `Page loaded but "${site.expected_text.slice(0, 40)}" was not found`,
      };
    }

    if (responseMs > SLOW_MS) {
      return {
        ok: true,
        verdict: "slow",
        statusCode: response.status,
        responseMs,
        sslDaysLeft,
        error: `Took ${(responseMs / 1000).toFixed(1)}s to respond`,
      };
    }

    return {
      ok: true,
      verdict: "up",
      statusCode: response.status,
      responseMs,
      sslDaysLeft,
      error: null,
    };
  } catch (err) {
    return {
      ok: false,
      verdict: "down",
      statusCode: null,
      responseMs: Date.now() - started,
      sslDaysLeft,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface MonitorSweepResult {
  checked: number;
  up: number;
  down: number;
  incidentsOpened: number;
  incidentsResolved: number;
}

export async function runMonitorSweep(): Promise<MonitorSweepResult> {
  const sites = listMonitoredWebsites();
  const result: MonitorSweepResult = {
    checked: 0,
    up: 0,
    down: 0,
    incidentsOpened: 0,
    incidentsResolved: 0,
  };

  for (const site of sites) {
    const outcome = await checkWebsite(site);
    result.checked += 1;

    recordHealthCheck({
      website_id: site.id,
      ok: outcome.ok,
      status_code: outcome.statusCode,
      response_ms: outcome.responseMs,
      ssl_days_left: outcome.sslDaysLeft,
      verdict: outcome.verdict,
      error: outcome.error,
    });

    // 'slow' counts as up for availability, but still deserves an incident so
    // the owner sees a sustained slowdown rather than only a hard outage.
    const failing = !outcome.ok || outcome.verdict === "slow";
    const existing = openIncident(site.id);

    if (failing) {
      if (outcome.ok) result.up += 1;
      else result.down += 1;

      if (existing) {
        bumpIncident(existing.id, outcome.error ?? outcome.verdict);
      } else {
        // Look back at the previous check: declare an incident only after
        // consecutive failures, so one blip does not page anyone.
        const priorFailures = countRecentConsecutiveFailures(site.id);
        if (priorFailures >= FAILURES_BEFORE_INCIDENT) {
          startIncident(site.id, outcome.verdict, outcome.error ?? outcome.verdict);
          result.incidentsOpened += 1;
          logEvent(
            "site.incident",
            `${site.url} is ${describeVerdict(outcome.verdict)}: ${outcome.error ?? ""}`.trim(),
            { businessId: site.business_id, level: "error", data: { verdict: outcome.verdict } },
          );
        }
      }
    } else {
      result.up += 1;
      if (existing) {
        resolveIncident(existing.id);
        result.incidentsResolved += 1;
        logEvent("site.recovered", `${site.url} is back to normal`, {
          businessId: site.business_id,
        });
      }
    }

    if (
      outcome.sslDaysLeft !== null &&
      outcome.sslDaysLeft <= CERT_WARN_DAYS &&
      outcome.sslDaysLeft >= 0
    ) {
      logEvent(
        "site.cert_expiring",
        `TLS certificate for ${site.url} expires in ${outcome.sslDaysLeft} days`,
        { businessId: site.business_id, level: "warn" },
      );
    }
  }

  return result;
}

/** Counts failing checks at the tail of the history, including the newest. */
function countRecentConsecutiveFailures(websiteId: string): number {
  let count = 0;
  for (const check of recentChecks(websiteId, 10)) {
    if (check.ok === 1 && check.verdict !== "slow") break;
    count += 1;
  }
  return count;
}

export function describeVerdict(verdict: Verdict): string {
  switch (verdict) {
    case "up":
      return "working normally";
    case "down":
      return "unreachable";
    case "broken":
      return "returning an error";
    case "slow":
      return "responding slowly";
    case "content_missing":
      return "loading but missing its content";
  }
}
