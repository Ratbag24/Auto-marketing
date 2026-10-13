import { barChart, lineChart, fmtNum, fmtPct } from "./charts.js";

const $ = (id) => document.getElementById(id);

const CHANNEL_LABELS = {
  email: "Email",
  x: "X",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
};

let overview = null;
let stats = null;
let currentId = null;

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned non-JSON (${res.status})`);
  }
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body;
}

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

function when(iso) {
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const rel =
    mins < 60
      ? `${mins}m`
      : mins < 1440
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / 1440)}d`;
  return diff >= 0 ? `in ${rel}` : `${rel} ago`;
}

/* ---------------------------------------------------------------- banners */

function renderBanners() {
  const out = [];

  if (!overview.publishing_enabled) {
    out.push(
      `<div class="banner stop"><span class="icon">■</span><div>
        <b>Publishing is switched off.</b> PUBLISHING_ENABLED is false, so
        nothing is being sent on any channel. Content is still planned and
        queued.
      </div></div>`,
    );
  }

  const simulated = overview.channels.filter((c) => !c.live);
  if (simulated.length > 0) {
    const names = simulated.map((c) => CHANNEL_LABELS[c.channel] ?? c.channel);
    out.push(
      `<div class="banner warn"><span class="icon">▲</span><div>
        <b>${names.length === overview.channels.length ? "Every channel is" : `${esc(names.join(", "))} ${names.length === 1 ? "is" : "are"}`}
        in simulation mode.</b>
        Posts are recorded but never sent, and the figures below are generated,
        not real audience behaviour. Add credentials to go live &mdash; see the
        Channels panel.
      </div></div>`,
    );
  }

  if (stats?.performance.cold_start && stats.performance.items_measured > 0) {
    out.push(
      `<div class="banner"><span class="icon">◆</span><div>
        Only <b>${stats.performance.items_measured}</b> measured posts so far.
        The planner is still exploring evenly rather than optimising; it starts
        shifting weight once there are 8.
      </div></div>`,
    );
  }

  $("banners").innerHTML = out.join("");
}

/* ------------------------------------------------------------------ tiles */

function renderTiles() {
  const p = stats.performance;
  const f = stats.funnel;
  const tiles = [
    {
      label: "Impressions",
      value: fmtNum(p.totals.impressions),
      sub: `${p.items_measured} posts measured`,
    },
    {
      label: "Engagement rate",
      value: fmtPct(p.totals.engagement_rate),
      sub: `${fmtNum(p.totals.engagements)} engagements`,
    },
    {
      label: "Conversions",
      value: fmtNum(p.totals.conversions),
      sub: p.totals.conversions === 0 ? "needs site analytics" : "attributed",
    },
    {
      label: "Published",
      value: String(f.published),
      sub: `${f.scheduled} queued${f.failed ? `, ${f.failed} failed` : ""}`,
    },
    {
      label: "Model spend",
      value: `$${stats.spend.usd.toFixed(2)}`,
      sub: `${fmtNum(stats.spend.input_tokens + stats.spend.output_tokens)} tokens, all time`,
    },
  ];

  $("tiles").innerHTML = tiles
    .map(
      (t) => `<div class="tile">
        <div class="label">${esc(t.label)}</div>
        <div class="value">${esc(t.value)}</div>
        <div class="sub">${esc(t.sub)}</div>
      </div>`,
    )
    .join("");
}

/* ----------------------------------------------------------------- charts */

function renderCharts() {
  const daily = stats.daily;

  lineChart(
    $("chart-reach"),
    daily.map((d) => ({ date: d.date, value: d.impressions })),
    { color: "var(--series-1)", format: fmtNum, label: "impressions" },
  );

  // Rate, not a raw count - plotted as its own chart rather than sharing an
  // axis with impressions.
  lineChart(
    $("chart-engagement"),
    daily.map((d) => ({
      date: d.date,
      value: d.impressions > 0 ? d.engagements / d.impressions : 0,
    })),
    { color: "var(--series-2)", format: (v) => fmtPct(v, 1), label: "engagement rate" },
  );

  const p = stats.performance;

  barChart(
    $("chart-channel"),
    p.by_channel.map((c) => ({
      label: CHANNEL_LABELS[c.key] ?? c.key,
      value: c.engagement_rate,
      note: `${c.items} posts`,
    })),
    { empty: "No channel data yet." },
  );

  barChart(
    $("chart-pillar"),
    p.by_pillar.slice(0, 8).map((c) => ({
      label: c.key.length > 14 ? `${c.key.slice(0, 13)}…` : c.key,
      value: c.engagement_rate,
      note: `${c.items} posts`,
    })),
    { empty: "No pillar data yet." },
  );

  barChart(
    $("chart-hour"),
    [...p.by_hour]
      .sort((a, b) => b.engagement_rate - a.engagement_rate)
      .slice(0, 6)
      .map((c) => ({
        label: `${c.key}:00`,
        value: c.engagement_rate,
        note: `${c.items} posts`,
      })),
    { empty: "No timing data yet." },
  );
}

/* -------------------------------------------------------- strategy & queue */

function renderStrategy() {
  const plan = stats.lastPlan;
  $("plan-meta").textContent = plan.at
    ? `Last planned ${when(plan.at)} · ${plan.items} items · ${plan.status}`
    : "No planning run yet";
  $("plan-note").textContent =
    plan.note ?? "The next planning run will write its reasoning here.";
}

function renderControls() {
  const b = stats.business;
  $("controls").innerHTML = `
    <div class="field">
      <label for="c-autopilot">Autopilot</label>
      <select id="c-autopilot">
        <option value="on" ${b.autopilot === 1 ? "selected" : ""}>On — publishing on schedule</option>
        <option value="off" ${b.autopilot !== 1 ? "selected" : ""}>Off — queue but never send</option>
      </select>
    </div>
    <div class="field">
      <label for="c-approval">New content</label>
      <select id="c-approval">
        <option value="auto" ${b.approval_mode === "auto" ? "selected" : ""}>Publishes automatically</option>
        <option value="review" ${b.approval_mode === "review" ? "selected" : ""}>Waits for my review</option>
      </select>
    </div>
    <div class="field">
      <label for="c-volume">Posts per week</label>
      <input id="c-volume" type="number" min="1" max="50" value="${b.weekly_volume}">
    </div>
    <button id="c-save">Save</button>
  `;

  $("c-save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      await api(`/businesses/${currentId}`, {
        method: "PATCH",
        body: JSON.stringify({
          autopilot: $("c-autopilot").value === "on",
          approval_mode: $("c-approval").value,
          weekly_volume: Number($("c-volume").value),
        }),
      });
      await load(currentId);
    } catch (err) {
      alert(err.message);
      button.disabled = false;
      button.textContent = "Save";
    }
  });
}

function itemRows(items, withActions) {
  return items
    .map(
      (i) => `<tr>
        <td><span class="pill">${esc(CHANNEL_LABELS[i.channel] ?? i.channel)}</span></td>
        <td class="muted">${esc(i.pillar)}</td>
        <td class="truncate" style="width:100%">${esc(i.preview ?? "")}</td>
        <td class="num muted">${esc(when(i.scheduled_at))}</td>
        ${
          withActions
            ? `<td class="num" style="white-space:nowrap">
                 <button data-approve="${esc(i.id)}">Approve</button>
                 <button class="danger" data-reject="${esc(i.id)}">Reject</button>
               </td>`
            : ""
        }
      </tr>`,
    )
    .join("");
}

function renderQueues() {
  const upcoming = stats.upcoming;

  $("upcoming").innerHTML = upcoming.length
    ? `<table><thead><tr>
         <th>Channel</th><th>Pillar</th><th>Preview</th><th class="num">When</th>
       </tr></thead><tbody>${itemRows(upcoming, false)}</tbody></table>`
    : `<div class="empty">Nothing queued. Run a planning cycle to fill the calendar.</div>`;
}

async function renderReview() {
  const { items } = await api(`/businesses/${currentId}/content`);
  const drafts = items
    .filter((i) => i.status === "draft")
    .map((i) => ({
      ...i,
      preview: (i.subject ?? i.body).replace(/\s+/g, " ").slice(0, 110),
    }));

  const card = $("review-card");
  if (drafts.length === 0) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $("review").innerHTML =
    `<table><thead><tr>
       <th>Channel</th><th>Pillar</th><th>Preview</th>
       <th class="num">When</th><th class="num">Action</th>
     </tr></thead><tbody>${itemRows(drafts, true)}</tbody></table>`;

  for (const button of $("review").querySelectorAll("[data-approve],[data-reject]")) {
    button.addEventListener("click", async () => {
      const id = button.dataset.approve ?? button.dataset.reject;
      const action = button.dataset.approve ? "approve" : "reject";
      button.disabled = true;
      try {
        await api(`/items/${id}/${action}`, { method: "POST" });
        await load(currentId);
      } catch (err) {
        alert(err.message);
        button.disabled = false;
      }
    });
  }
}

function renderChannels() {
  const enabled = new Set(stats.channels);
  $("channels").innerHTML = `<ul class="chan-list">${overview.channels
    .map((c) => {
      const on = enabled.has(c.channel);
      const pill = c.live
        ? `<span class="pill live"><span class="dot"></span>Live</span>`
        : `<span class="pill sim"><span class="dot"></span>Simulated</span>`;
      return `<li>
        <div class="chan-head">
          <b>${esc(CHANNEL_LABELS[c.channel] ?? c.channel)}</b>
          ${on ? "" : `<span class="muted">not in use</span>`}
          ${pill}
        </div>
        <div class="chan-hint">${esc(c.hint)}</div>
      </li>`;
    })
    .join("")}</ul>`;
}

function renderEvents() {
  const events = overview.events.filter(
    (e) => !e.business_id || e.business_id === currentId,
  );
  $("events").innerHTML = events.length
    ? events
        .slice(0, 14)
        .map(
          (e) => `<li>
            <time>${esc(when(e.created_at))}</time>
            <span class="lvl-${esc(e.level)}">${esc(e.message)}</span>
          </li>`,
        )
        .join("")
    : `<li class="muted">Nothing yet.</li>`;
}

/* ------------------------------------------------------------------ load */

async function load(id) {
  overview = await api("/overview");

  const select = $("biz");
  select.innerHTML = overview.businesses
    .map((b) => `<option value="${esc(b.id)}">${esc(b.name)}</option>`)
    .join("");

  if (overview.businesses.length === 0) {
    $("main").hidden = true;
    $("onboard").hidden = false;
    renderBanners();
    return;
  }

  currentId = id ?? overview.businesses[0].id;
  select.value = currentId;

  stats = await api(`/businesses/${currentId}`);

  $("main").hidden = false;
  // The onboarding card stays available so further businesses can be added.
  $("onboard").hidden = false;

  renderBanners();
  renderTiles();
  renderCharts();
  renderStrategy();
  renderControls();
  renderQueues();
  renderChannels();
  renderEvents();
  await renderReview();
}

/* ----------------------------------------------------------------- wiring */

$("biz").addEventListener("change", (e) => void load(e.target.value));
$("refresh").addEventListener("click", () => void load(currentId));

$("theme").addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem("autopilot-theme", next);
  } catch {
    /* private mode - the toggle still works for this session */
  }
});

try {
  const saved = localStorage.getItem("autopilot-theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  /* ignore */
}

async function runAction(button, path, label) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = `${label}…`;
  try {
    const result = await api(path, { method: "POST" });
    await load(currentId);
    button.textContent = original;
    return result;
  } catch (err) {
    alert(err.message);
    button.textContent = original;
  } finally {
    button.disabled = false;
  }
}

$("replan").addEventListener("click", (e) =>
  void runAction(e.currentTarget, `/businesses/${currentId}/plan`, "Planning"),
);
$("sweep").addEventListener("click", (e) =>
  void runAction(e.currentTarget, "/sweeps/publish", "Publishing"),
);

// Onboarding form
const CHANNEL_CHOICES = [
  ["email", "Email", true],
  ["x", "X", true],
  ["linkedin", "LinkedIn", true],
  ["facebook", "Facebook", false],
  ["instagram", "Instagram", false],
];
$("f-channels").innerHTML = CHANNEL_CHOICES.map(
  ([value, label, on]) =>
    `<label><input type="checkbox" value="${value}" ${on ? "checked" : ""}>${label}</label>`,
).join("");

$("onboard-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $("f-submit");
  const status = $("f-status");

  const channels = [...$("f-channels").querySelectorAll("input:checked")].map(
    (i) => i.value,
  );
  if (channels.length === 0) {
    status.textContent = "Pick at least one channel.";
    return;
  }

  submit.disabled = true;
  status.textContent =
    "Analysing the brand and writing the first fortnight. This takes a minute.";

  try {
    const data = new FormData(form);
    const result = await api("/businesses", {
      method: "POST",
      body: JSON.stringify({
        name: data.get("name"),
        one_liner: data.get("one_liner"),
        audience: data.get("audience"),
        tone: data.get("tone"),
        website: data.get("website") || null,
        weekly_volume: Number(data.get("weekly_volume")),
        approval_mode: data.get("approval_mode"),
        channels,
      }),
    });
    form.reset();
    status.textContent = `Created. ${result.plan?.items_created ?? 0} items planned.`;
    await load(result.business.id);
  } catch (err) {
    status.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

void load();
