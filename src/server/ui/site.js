/* Website panels: status, audience and content. Kept separate from app.js so
   the marketing dashboard and the website dashboard stay readable apart. */

import { barChart, lineChart, fmtNum, fmtPct } from "./charts.js";

const $ = (id) => document.getElementById(id);

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function ago(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function duration(seconds) {
  if (!seconds) return "0s";
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/* ------------------------------------------------------------------ health */

function renderHealth(site, health) {
  $("site-url").innerHTML =
    `<a href="${esc(site.url)}" target="_blank" rel="noopener noreferrer">${esc(site.url)}</a>` +
    (site.verified_at
      ? ` · <span class="pill live"><span class="dot"></span>Tracker installed</span>`
      : ` · <span class="pill sim"><span class="dot"></span>Tracker not detected</span>`);

  const verdict = health.verdict ?? "unknown";
  const label =
    verdict === "up"
      ? "Working normally"
      : verdict === "slow"
        ? "Slow"
        : verdict === "down"
          ? "Not reachable"
          : verdict === "broken"
            ? "Returning an error"
            : verdict === "content_missing"
              ? "Loading but content missing"
              : "Not checked yet";

  const incident = health.open_incident;
  const pct = (v) => (v === null ? "—" : `${(v * 100).toFixed(2)}%`);

  $("site-health").innerHTML = `
    ${
      site.monitor_enabled === 0
        ? `<div class="banner" style="margin-bottom:14px">
             <span class="icon">◆</span>
             <div>Monitoring is paused for this site. The figures below are the
             last recorded history, not a live reading.</div>
           </div>`
        : ""
    }
    <div class="status-line">
      <span class="status-dot ${esc(verdict)}"></span>
      <div>
        <div class="status-text">${esc(label)}</div>
        <div class="status-sub">
          Checked ${esc(ago(health.last_checked))}${
            health.response_ms !== null ? ` · ${health.response_ms}ms` : ""
          }
        </div>
      </div>
    </div>
    ${
      incident
        ? `<div class="banner stop" style="margin-bottom:14px">
             <span class="icon">■</span>
             <div><b>Open since ${esc(ago(incident.started_at))}.</b>
             ${esc(incident.detail ?? "")} (${incident.checks_failed} failed checks)</div>
           </div>`
        : ""
    }
    <dl class="kv">
      <dt>Uptime, 24h</dt><dd>${pct(health.uptime_24h)} <span class="muted">(${health.checks_24h} checks)</span></dd>
      <dt>Uptime, 30d</dt><dd>${pct(health.uptime_30d)}</dd>
      <dt>Average response</dt><dd>${health.avg_response_ms === null ? "—" : `${health.avg_response_ms}ms`}</dd>
      <dt>TLS certificate</dt><dd>${
        health.ssl_days_left === null
          ? "—"
          : health.ssl_days_left < 0
            ? `<span style="color:var(--critical)">expired</span>`
            : health.ssl_days_left <= 14
              ? `<span style="color:var(--warning)">${health.ssl_days_left} days left</span>`
              : `${health.ssl_days_left} days left`
      }</dd>
    </dl>
    <div class="sparkbar" title="Recent checks, oldest first">
      ${health.recent
        .map((c) => {
          const cls = c.ok ? (c.verdict === "slow" ? "warn" : "") : "bad";
          const h = c.ms === null ? 30 : Math.max(18, Math.min(100, (c.ms / 2000) * 100));
          return `<span class="${cls}" style="height:${h}%" title="${esc(c.verdict)}${
            c.ms !== null ? ` ${c.ms}ms` : ""
          }"></span>`;
        })
        .join("")}
    </div>
  `;

  lineChart(
    $("chart-response"),
    health.recent.map((c) => ({ date: c.at, value: c.ms ?? 0 })),
    {
      color: "var(--series-3)",
      format: (v) => `${Math.round(v)}ms`,
      label: "response",
      // This series spans hours, so show the day and the time.
      xLabel: (iso) => {
        const d = new Date(iso);
        return `${String(d.getUTCDate()).padStart(2, "0")}/${String(
          d.getUTCMonth() + 1,
        ).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(
          d.getUTCMinutes(),
        ).padStart(2, "0")}`;
      },
    },
  );

  const past = health.incidents.filter((i) => i.resolved_at !== null);
  $("site-incidents").innerHTML = past.length
    ? `<table><thead><tr><th>Issue</th><th>Started</th><th class="num">Lasted</th></tr></thead>
       <tbody>${past
         .slice(0, 5)
         .map((i) => {
           const mins = Math.round(
             (new Date(i.resolved_at).getTime() - new Date(i.started_at).getTime()) / 60000,
           );
           return `<tr><td>${esc(i.kind)}</td><td class="muted">${esc(ago(i.started_at))}</td>
                   <td class="num muted">${mins}m</td></tr>`;
         })
         .join("")}</tbody></table>`
    : `<p class="muted" style="font-size:13px;margin:0">No past incidents.</p>`;
}

/* ---------------------------------------------------------------- audience */

function renderAudience(site, audience) {
  const t = audience.totals;

  $("audience-tiles").innerHTML = [
    { label: "Visitors", value: fmtNum(t.visitors), sub: `last ${audience.window_days} days` },
    { label: "Pageviews", value: fmtNum(t.views), sub: `${fmtNum(t.sessions)} sessions` },
    {
      label: "Pages per visit",
      value: t.pages_per_session.toFixed(1),
      sub: `${fmtPct(t.bounce_rate, 0)} left after one page`,
    },
    { label: "Time on site", value: duration(t.avg_session_seconds), sub: "average session" },
    {
      label: "Goal completions",
      value: fmtNum(t.goals),
      sub: site.goal_path ? esc(site.goal_path) : "no goal page set",
    },
  ]
    .map(
      (tile) => `<div class="tile">
        <div class="label">${esc(tile.label)}</div>
        <div class="value">${esc(tile.value)}</div>
        <div class="sub">${tile.sub}</div>
      </div>`,
    )
    .join("");

  lineChart(
    $("chart-visitors"),
    audience.daily.map((d) => ({ date: d.date, value: d.visitors })),
    { color: "var(--series-1)", format: fmtNum, label: "visitors" },
  );

  const share = (rows) =>
    rows.map((r) => ({ label: r.label, value: r.share, note: `${r.visitors} visitors` }));

  barChart($("chart-countries"), share(audience.countries.slice(0, 8)), {
    format: (v) => fmtPct(v, 1),
    empty: "No location data yet. Install the tracker to see where visitors are.",
  });

  barChart($("chart-sources"), share(audience.sources.slice(0, 6)), {
    format: (v) => fmtPct(v, 1),
    color: "var(--series-2)",
    empty: "No traffic yet.",
  });

  barChart($("chart-devices"), share(audience.devices), {
    format: (v) => fmtPct(v, 1),
    color: "var(--series-3)",
    empty: "No device data yet.",
  });

  $("top-pages").innerHTML = audience.top_pages.length
    ? `<table><thead><tr><th>Page</th><th class="num">Views</th></tr></thead>
       <tbody>${audience.top_pages
         .slice(0, 8)
         .map(
           (p) =>
             `<tr><td class="truncate" style="width:100%">${esc(p.path)}</td>
              <td class="num">${p.views}</td></tr>`,
         )
         .join("")}</tbody></table>`
    : `<div class="empty">No pageviews recorded yet.</div>`;

  $("attributed").innerHTML = audience.attributed.length
    ? `<table><thead><tr>
         <th>Post</th><th class="num">Visits</th><th class="num">Goals</th>
       </tr></thead><tbody>${audience.attributed
         .map(
           (a) => `<tr>
             <td><span class="pill">${esc(a.channel)}</span>
               <span class="muted">${esc(a.pillar)}</span><br>
               <span class="truncate" style="display:block;max-width:320px">${esc(a.excerpt)}</span></td>
             <td class="num">${a.visits}</td>
             <td class="num">${a.goals}</td>
           </tr>`,
         )
         .join("")}</tbody></table>`
    : `<div class="empty">
         No visits traced to a post yet. Links to your site in published content
         are tagged automatically, so this fills in once tagged posts go out.
       </div>`;
}

/* ----------------------------------------------------------------- content */

function renderContent(site, content) {
  $("crawl-meta").textContent = content
    ? `${content.total_pages} pages read ${ago(site.last_crawled_at)} · ` +
      `${content.pages_with_issues} with issues`
    : "Not read yet";

  if (!content || content.total_pages === 0) {
    $("site-issues").innerHTML = `<div class="empty">No pages read yet.</div>`;
    return;
  }

  $("site-issues").innerHTML = content.top_issues.length
    ? `<table><thead><tr><th>Issue found</th><th class="num">Pages</th></tr></thead>
       <tbody>${content.top_issues
         .map(
           (i) =>
             `<tr><td>${esc(i.issue)}</td><td class="num">${i.count}</td></tr>`,
         )
         .join("")}</tbody></table>`
    : `<p class="muted" style="font-size:13px;margin:0">
         No problems found across ${content.total_pages} pages.
       </p>`;
}

/* -------------------------------------------------------------------- main */

export function renderWebsite(data, { onAction }) {
  const connect = $("site-connect");
  const panels = $("site-panels");

  if (!data.website) {
    connect.hidden = false;
    panels.hidden = true;
    return;
  }

  connect.hidden = true;
  panels.hidden = false;

  renderHealth(data.website, data.health);
  renderAudience(data.website, data.audience);
  renderContent(data.website, data.content);

  // The snippet only matters until it is installed.
  const snippetCard = $("snippet-card");
  if (data.snippet && !data.website.verified_at) {
    snippetCard.hidden = false;
    $("site-snippet").textContent = data.snippet;
  } else {
    snippetCard.hidden = true;
  }

  $("recrawl").onclick = (e) => onAction(e.currentTarget, "crawl", "Reading");
  $("recheck").onclick = (e) => onAction(e.currentTarget, "check", "Checking");
}

export function wireSnippetCopy() {
  const button = $("copy-snippet");
  if (!button) return;
  button.addEventListener("click", async () => {
    const text = $("site-snippet").textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1500);
    } catch {
      // Clipboard needs a secure context; select the text instead.
      const range = document.createRange();
      range.selectNodeContents($("site-snippet"));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      button.textContent = "Select and copy";
    }
  });
}
