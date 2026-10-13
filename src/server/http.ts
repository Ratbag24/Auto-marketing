import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { handleApi } from "./api.js";
import { collect, type CollectPayload } from "../web/collect.js";
import { trackerScript } from "../web/tracker.js";

const here = dirname(fileURLToPath(import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function uiDir(): string {
  for (const candidate of [join(here, "ui"), join(here, "../../src/server/ui")]) {
    try {
      readFileSync(join(candidate, "index.html"));
      return candidate;
    } catch {
      /* try next */
    }
  }
  throw new Error("Could not locate the dashboard UI directory");
}

/**
 * The visitor's address, used only to derive a daily-rotating hash - it is
 * never stored. x-forwarded-for is trusted because this process is expected to
 * sit behind a proxy; without one the socket address is already correct.
 */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw) {
    const first = raw.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "0.0.0.0";
}

function constantTimeEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Every route is behind ADMIN_TOKEN. The token may arrive as a bearer header
 * (for API clients) or a cookie (so the dashboard works in a browser).
 */
function authorized(req: IncomingMessage): boolean {
  if (config.adminToken === "") {
    // No token configured: only allow loopback, so a misconfigured deploy is
    // not silently world-readable.
    const addr = req.socket.remoteAddress ?? "";
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }

  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ")) {
    return constantTimeEquals(header.slice(7), config.adminToken);
  }

  const cookie = req.headers.cookie ?? "";
  const match = /(?:^|;\s*)autopilot_token=([^;]+)/.exec(cookie);
  if (match?.[1]) {
    return constantTimeEquals(decodeURIComponent(match[1]), config.adminToken);
  }

  return false;
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const dir = uiDir();
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  // normalize then confirm the result is still inside the UI directory.
  const target = normalize(join(dir, rel));
  if (!target.startsWith(normalize(dir))) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = readFileSync(target);
    const ext = target.slice(target.lastIndexOf("."));
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

export function startServer(): void {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // Health check stays open so a load balancer can reach it.
      if (url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // ---- public tracking endpoints -------------------------------------
      // These sit before the auth gate on purpose: they are called by ordinary
      // visitors on the customer's website, who have no admin token.

      if (url.pathname === "/t.js") {
        const base = config.publicUrl || `http://localhost:${config.port}`;
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(trackerScript(`${base}/api/collect`));
        return;
      }

      if (url.pathname === "/api/collect") {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "86400",
          });
          res.end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405, { "Access-Control-Allow-Origin": "*" });
          res.end();
          return;
        }

        // Always answer 204 regardless of outcome. A public endpoint that
        // reports why it rejected something tells an attacker which tracking
        // keys are real.
        const answer = () => {
          res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
          res.end();
        };

        try {
          const body = (await readBody(req, 8192)) as CollectPayload;
          collect(body, {
            ip: clientIp(req),
            userAgent: String(req.headers["user-agent"] ?? ""),
            headers: req.headers as Record<string, string | string[] | undefined>,
          });
        } catch {
          /* malformed beacon - drop it silently */
        }
        answer();
        return;
      }

      // Lets the dashboard exchange a token in the URL for a cookie.
      if (url.pathname === "/login" && url.searchParams.has("token")) {
        const token = url.searchParams.get("token")!;
        if (config.adminToken !== "" && constantTimeEquals(token, config.adminToken)) {
          res.writeHead(302, {
            "Set-Cookie": `autopilot_token=${encodeURIComponent(token)}; ` +
              `HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
            Location: "/",
          });
          res.end();
        } else {
          res.writeHead(401).end("Invalid token");
        }
        return;
      }

      if (!authorized(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              config.adminToken === ""
                ? "ADMIN_TOKEN is not set, so access is restricted to localhost."
                : "Unauthorized. Visit /login?token=YOUR_ADMIN_TOKEN.",
          }),
        );
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        try {
          const body = req.method === "GET" ? {} : await readBody(req);
          const result = await handleApi(req.method ?? "GET", url, body);
          res.writeHead(result.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result.body));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
        return;
      }

      serveStatic(res, url.pathname);
    })();
  });

  server.listen(config.port, () => {
    console.log(`[server] dashboard on http://localhost:${config.port}`);
    if (config.adminToken === "") {
      console.warn(
        "[server] ADMIN_TOKEN is not set - access is limited to localhost. " +
          "Set it before exposing this to the internet.",
      );
    }
  });
}
