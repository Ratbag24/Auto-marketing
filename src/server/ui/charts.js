/* Hand-rolled SVG charts. No chart library: the shapes needed here are simple,
   and a dependency-free dashboard is one less thing to maintain or pay for.

   Conventions applied throughout (see the project README):
   - single series per chart, so the title carries identity and no legend is
     needed;
   - 2px lines, >=8px hover markers, 4px rounded bar ends anchored to baseline,
     2px gaps between bars;
   - recessive grid, direct value labels on every bar.
*/

const NS = "http://www.w3.org/2000/svg";

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

export function fmtNum(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtPct(x, digits = 2) {
  return `${(x * 100).toFixed(digits)}%`;
}

function niceCeil(max) {
  if (max <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (max <= step * mag) return step * mag;
  }
  return 10 * mag;
}

function emptyState(container, message) {
  container.innerHTML = `<div class="empty">${message}</div>`;
}

/* ------------------------------------------------------------------------
   Time series: area + line, with a crosshair and tooltip.
   `format` renders the value in the tooltip and on the y axis.
------------------------------------------------------------------------ */
export function lineChart(container, points, opts = {}) {
  const {
    color = "var(--series-1)",
    format = fmtNum,
    yMax: forcedMax,
    label = "value",
  } = opts;

  container.innerHTML = "";
  if (!points.length) {
    emptyState(container, "No measurements yet.");
    return;
  }

  const W = 560;
  const H = 210;
  const pad = { top: 12, right: 10, bottom: 26, left: 44 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const values = points.map((p) => p.value);
  const yMax = forcedMax ?? niceCeil(Math.max(...values, 0));
  const x = (i) =>
    pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => pad.top + plotH - (yMax === 0 ? 0 : (v / yMax) * plotH);

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": `${label} over time`,
    preserveAspectRatio: "none",
  });

  // Gridlines and y labels at 0, 50%, 100%.
  for (const frac of [0, 0.5, 1]) {
    const v = yMax * frac;
    svg.appendChild(
      el("line", {
        class: "gridline",
        x1: pad.left,
        x2: pad.left + plotW,
        y1: y(v),
        y2: y(v),
      }),
    );
    svg.appendChild(
      el(
        "text",
        {
          class: "axis-label",
          x: pad.left - 7,
          y: y(v) + 3.5,
          "text-anchor": "end",
        },
        format(v),
      ),
    );
  }

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.value)}`).join(" ");
  const areaPath =
    `${linePath} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;

  const gradientId = `grad-${Math.random().toString(36).slice(2, 9)}`;
  const defs = el("defs");
  const grad = el("linearGradient", {
    id: gradientId,
    x1: 0, y1: 0, x2: 0, y2: 1,
  });
  grad.appendChild(el("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.22 }));
  grad.appendChild(el("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0.02 }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  svg.appendChild(el("path", { d: areaPath, fill: `url(#${gradientId})` }));
  svg.appendChild(
    el("path", {
      d: linePath,
      fill: "none",
      stroke: color,
      "stroke-width": 2,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
    }),
  );

  svg.appendChild(
    el("line", {
      class: "axis-line",
      x1: pad.left,
      x2: pad.left + plotW,
      y1: y(0),
      y2: y(0),
    }),
  );

  // First and last date labels only - a label per point would collide.
  const dateLabel = (iso) => iso.slice(5).replace("-", "/");
  svg.appendChild(
    el(
      "text",
      { class: "axis-label", x: pad.left, y: H - 8, "text-anchor": "start" },
      dateLabel(points[0].date),
    ),
  );
  if (points.length > 1) {
    svg.appendChild(
      el(
        "text",
        {
          class: "axis-label",
          x: pad.left + plotW,
          y: H - 8,
          "text-anchor": "end",
        },
        dateLabel(points[points.length - 1].date),
      ),
    );
  }

  // Hover layer: crosshair, marker and tooltip.
  const crosshair = el("line", {
    class: "gridline",
    y1: pad.top,
    y2: pad.top + plotH,
    stroke: "var(--border-strong)",
    opacity: 0,
  });
  const marker = el("circle", {
    r: 4.5,
    fill: color,
    stroke: "var(--surface-1)",
    "stroke-width": 2,
    opacity: 0,
  });
  svg.appendChild(crosshair);
  svg.appendChild(marker);

  container.appendChild(svg);

  const tip = document.createElement("div");
  tip.className = "tooltip";
  container.appendChild(tip);

  const hit = el("rect", {
    x: pad.left,
    y: pad.top,
    width: plotW,
    height: plotH,
    fill: "transparent",
  });
  svg.appendChild(hit);

  const onMove = (event) => {
    const box = svg.getBoundingClientRect();
    const relX = ((event.clientX - box.left) / box.width) * W;
    const ratio = Math.min(1, Math.max(0, (relX - pad.left) / plotW));
    const i = Math.round(ratio * (points.length - 1));
    const p = points[i];
    if (!p) return;

    crosshair.setAttribute("x1", x(i));
    crosshair.setAttribute("x2", x(i));
    crosshair.setAttribute("opacity", 1);
    marker.setAttribute("cx", x(i));
    marker.setAttribute("cy", y(p.value));
    marker.setAttribute("opacity", 1);

    tip.innerHTML =
      `<div class="tt-date">${p.date}</div>` +
      `<div class="tt-row"><span class="swatch" style="background:${color}"></span>` +
      `${format(p.value)} ${label}</div>`;
    tip.style.left = `${(x(i) / W) * box.width}px`;
    tip.style.top = `${(y(p.value) / H) * box.height - 10}px`;
    tip.classList.add("on");
  };

  const onLeave = () => {
    crosshair.setAttribute("opacity", 0);
    marker.setAttribute("opacity", 0);
    tip.classList.remove("on");
  };

  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);
}

/* ------------------------------------------------------------------------
   Horizontal bars for magnitude-by-category. Single hue: the comparison is
   one measure across categories, so colour carries no extra information.
   Every bar is directly labelled, which also satisfies the contrast relief
   rule for the lighter palette slots.
------------------------------------------------------------------------ */
export function barChart(container, rows, opts = {}) {
  const {
    color = "var(--series-1)",
    format = fmtPct,
    empty = "Not enough data yet.",
  } = opts;

  container.innerHTML = "";
  if (!rows.length) {
    emptyState(container, empty);
    return;
  }

  const barH = 22;
  const gap = 2; // 2px surface gap between adjacent bars
  const W = 340;
  const labelW = 104;
  const valueW = 52;
  const H = rows.length * (barH + gap) + 8;
  const trackW = W - labelW - valueW;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`,
    role: "img",
    "aria-label": "Comparison by category",
  });

  rows.forEach((row, i) => {
    const y = i * (barH + gap) + 4;
    const w = Math.max(2, (row.value / max) * trackW);

    svg.appendChild(
      el(
        "text",
        {
          class: "bar-label",
          x: labelW - 9,
          y: y + barH / 2 + 4,
          "text-anchor": "end",
        },
        row.label,
      ),
    );

    // Track, so a short bar still reads as a proportion.
    svg.appendChild(
      el("rect", {
        x: labelW, y, width: trackW, height: barH,
        rx: 4, fill: "var(--surface-2)",
      }),
    );
    svg.appendChild(
      el("rect", {
        x: labelW, y, width: w, height: barH,
        rx: 4, fill: color,
      }),
    );
    svg.appendChild(
      el(
        "text",
        {
          class: "bar-value",
          x: labelW + trackW + 8,
          y: y + barH / 2 + 4,
        },
        format(row.value),
      ),
    );

    if (row.note) {
      const title = el("title", {}, `${row.label}: ${format(row.value)} (${row.note})`);
      svg.appendChild(title);
    }
  });

  container.appendChild(svg);
}
