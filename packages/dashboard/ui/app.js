// gerra dashboard UI: plain JS, hash routes, reads the local JSON API (read-only).
//   #/                                  tapes
//   #/tape/<tape>                       runs of a tape (trend, table), recorded routes, learned noise
//   #/tape/<tape>/run/<file>            one run's report: routes and where responses differ
//   #/tape/<tape>/run/<file>/ex/<id>    one exchange: recorded vs candidate, side by side
//   #/live                              shadow and cutover sessions, refreshed every 2 s

const app = document.getElementById("app");
const tip = document.getElementById("tip");
let refreshTimer = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const enc = encodeURIComponent;
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fmt = (n) => Number(n).toLocaleString("en-US");

async function api(path) {
  const res = await fetch(`/api/${path}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

function ago(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const when = (iso) => `<span title="${esc(new Date(iso).toLocaleString())}">${ago(iso)}</span>`;

/** ✓ / ✗ verdict for a summary, never color alone. */
function verdict(s) {
  if (!s) return `<span class="verdict none">– never replayed</span>`;
  const compared = s.identical + s.different;
  if (s.different + s.errors > 0) return `<span class="verdict bad">✗ ${s.different} different${s.errors ? `, ${plural(s.errors, "error")}` : ""}</span>`;
  if (compared === 0) return `<span class="verdict none">– nothing compared</span>`;
  return `<span class="verdict ok">✓ ${fmt(compared)} / ${fmt(compared)} identical</span>`;
}
const passRate = (s) => {
  const n = s.identical + s.different + s.errors;
  return n === 0 ? 0 : s.identical / n;
};

// ---------------------------------------------------------------------------------------------
// Tooltip

function bindTips(root) {
  root.querySelectorAll("[data-tip]").forEach((el) => {
    const show = (e) => {
      tip.innerHTML = el.getAttribute("data-tip");
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const x = e && e.clientX ? e.clientX : r.left + r.width / 2;
      tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 12, Math.max(12, x - tip.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(12, r.top - tip.offsetHeight - 10)}px`;
      el.closest("g")?.classList.add("on");
    };
    const hide = () => {
      tip.hidden = true;
      el.closest("g")?.classList.remove("on");
    };
    el.addEventListener("mouseenter", show);
    el.addEventListener("mousemove", show);
    el.addEventListener("mouseleave", hide);
    el.addEventListener("focus", () => show());
    el.addEventListener("blur", hide);
  });
}

// ---------------------------------------------------------------------------------------------
// Runs trend: one bar per run, height = share of replayed exchanges that were identical.

function runsChart(tape, runs) {
  const list = [...runs].reverse().slice(-40); // oldest → newest
  if (list.length === 0) return "";
  const W = 1000, H = 190, L = 44, R = 8, T = 10, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const slot = pw / Math.max(list.length, 8);
  const bw = Math.max(4, Math.min(30, slot - 2));
  const y = (v) => T + ph * (1 - v);
  let g = "";
  for (const v of [0, 0.5, 1]) {
    g += `<line class="${v === 0 ? "base" : "grid"}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text class="axis" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  }
  list.forEach((run, i) => {
    const s = run.summary;
    const v = passRate(s);
    const x = L + i * slot + (slot - bw) / 2;
    const top = y(v), h = Math.max(ph * v, 2), r = Math.min(4, bw / 2, h);
    const path = `M${x},${T + ph} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${T + ph} Z`;
    const ok = s.different + s.errors === 0 && s.identical > 0;
    const t = `${esc(new Date(run.startedAt).toLocaleString())}<br>${ok ? "✓ equivalent" : `✗ ${s.different} different, ${plural(s.errors, "error")}`}<br>${fmt(s.identical)} of ${fmt(s.identical + s.different + s.errors)} identical (${(v * 100).toFixed(1)}%)${s.skipped ? `<br>${fmt(s.skipped)} skipped` : ""}<br><span class="dim">against ${esc(run.against)}</span>`;
    g += `<g><a href="#/tape/${enc(tape)}/run/${enc(run.file)}" aria-label="Run ${esc(run.startedAt)}: ${(v * 100).toFixed(1)}% identical"><path class="bar" d="${path}"/><rect class="hit" x="${L + i * slot}" y="${T}" width="${slot}" height="${ph}" data-tip="${esc(t)}"/></a></g>`;
  });
  const first = list[0], last = list[list.length - 1];
  g += `<text class="axis" x="${L}" y="${H - 6}">${esc(new Date(first.startedAt).toLocaleDateString())}</text>`;
  if (list.length > 1) g += `<text class="axis" x="${L + (list.length - 1) * slot + slot / 2}" y="${H - 6}" text-anchor="middle">${esc(new Date(last.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</text>`;
  return `<div class="chart"><div class="title">Identical responses per run, oldest to newest</div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Share of identical responses for the last ${list.length} runs">${g}</svg></div>`;
}

function spark(runs) {
  const list = [...runs].reverse().slice(-24);
  if (list.length === 0) return "";
  return `<div class="spark" aria-hidden="true">${list.map((r) => `<i style="height:${Math.max(2, passRate(r.summary) * 28)}px"></i>`).join("")}</div>`;
}

// ---------------------------------------------------------------------------------------------
// Pages

async function tapesPage() {
  const tapes = await api("tapes");
  if (tapes.length === 0) {
    return `<h1>No tapes yet</h1><p class="sub">The dashboard reads <code>.gerra/</code> in the directory it was started from.</p>
      <div class="empty">Record traffic from the service you're rewriting:<br><br>
      <code>npx @gerra/cli record --target :3000 --port 8080 --tape main</code><br><br>
      then send requests to <code>localhost:8080</code> and replay them against the rewrite:<br><br>
      <code>npx @gerra/cli replay main --against :4000</code></div>`;
  }
  const cards = tapes
    .map((t) => {
      const last = t.runs[0];
      return `<a class="card" href="#/tape/${enc(t.name)}">
        <div class="name">${esc(t.name)}</div>
        <div class="meta">${fmt(t.exchanges)} exchanges · ${plural(t.routes.length, "route")}${t.error ? ` · <span class="err">${esc(t.error)}</span>` : ""}</div>
        <div>${verdict(last && last.summary)}</div>
        ${spark(t.runs)}
        <div class="meta">${last ? `last replay ${when(last.startedAt)} against <code>${esc(last.against)}</code>` : "not replayed yet"}</div>
      </a>`;
    })
    .join("");
  return `<h1>Tapes</h1><p class="sub">Recorded traffic, and how the rewrite did on it every time it was replayed.</p><div class="cards">${cards}</div>`;
}

async function tapePage(name) {
  const t = await api(`tapes/${enc(name)}`);
  const last = t.runs[0];
  const runsRows = t.runs
    .map((r) => {
      const s = r.summary;
      return `<tr class="link" data-href="#/tape/${enc(name)}/run/${enc(r.file)}">
        <td><a href="#/tape/${enc(name)}/run/${enc(r.file)}">${when(r.startedAt)}</a></td>
        <td>${s.different + s.errors > 0 ? '<span class="bad">✗</span>' : s.identical > 0 ? '<span class="good">✓</span>' : "–"}</td>
        <td class="n">${fmt(s.identical)}</td><td class="n">${fmt(s.different)}</td><td class="n">${fmt(s.errors)}</td><td class="n">${fmt(s.skipped)}</td>
        <td><code>${esc(r.against)}</code>${r.routes ? `<br><span class="dim">routes: ${esc(r.routes.join(", "))}</span>` : ""}${r.reset ? `<br><span class="dim">reset: ${esc(r.reset)}</span>` : ""}</td>
      </tr>`;
    })
    .join("");
  const routeRows = t.routes
    .map((r) => `<tr><td><code>${esc(r.route)}</code></td><td class="n">${fmt(r.count)}</td><td class="mono dim">${Object.entries(r.statuses).map(([k, v]) => `${k}×${v}`).join("  ")}</td></tr>`)
    .join("");
  const noise = t.noise && Object.keys(t.noise.routes).length
    ? `<h2>Learned noise</h2><p class="sub">Places where the original's own answers changed between two identical requests (learned from <code>${esc(t.noise.learnedFrom)}</code> ${when(t.noise.learnedAt)}, ${fmt(t.noise.samples)} samples). They don't count as differences.</p>
       <table><thead><tr><th>Route</th><th>Places</th></tr></thead><tbody>${Object.entries(t.noise.routes).map(([r, places]) => `<tr><td><code>${esc(r)}</code></td><td class="mono">${places.map(esc).join("<br>")}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<div class="crumbs"><a href="#/">Tapes</a> /</div>
    <h1>${esc(t.name)}</h1>
    <p class="sub">${fmt(t.exchanges)} exchanges · ${plural(t.routes.length, "route")}${t.firstAt ? ` · recorded ${when(t.firstAt)}` : ""} · <code>${esc(t.path)}</code></p>
    ${verdict(last && last.summary)}
    ${t.runs.length ? `<h2>Runs</h2>${runsChart(name, t.runs)}<br>
      <table><thead><tr><th>Started</th><th></th><th class="n">Identical</th><th class="n">Different</th><th class="n">Errors</th><th class="n">Skipped</th><th>Against</th></tr></thead><tbody>${runsRows}</tbody></table>`
      : `<h2>Runs</h2><div class="empty">Not replayed yet: <code>npx @gerra/cli replay ${esc(name)} --against :4000</code></div>`}
    <h2>Recorded routes</h2>
    <table><thead><tr><th>Route</th><th class="n">Exchanges</th><th>Statuses</th></tr></thead><tbody>${routeRows}</tbody></table>
    ${noise}`;
}

const REASONS = { noise: "learned noise", config: "config", timestamps: "timestamp", uuids: "uuid", ids: "id" };
const short = (id) => (/^ex_[0-9a-f]{8}-/.test(id) ? id.slice(0, 11) : id);
const val = (v) => (v === undefined ? "(none)" : esc(JSON.stringify(v).slice(0, 140)));

async function runPage(name, file) {
  const r = await api(`tapes/${enc(name)}/runs/${enc(file)}`);
  const s = r.report.summary;
  const lat = r.report.latency;
  const replayed = s.identical + s.different + s.errors;
  const pct = (n) => (replayed ? (n / replayed) * 100 : 0);
  const routes = r.report.routes
    .map((rt) => {
      const bad = rt.different + rt.errors > 0;
      const groups = rt.mismatches
        .map(
          (g) => `<div class="group"><span class="at">${esc(g.at)}</span><span class="count">×${fmt(g.count)}</span>
          ${g.samples
            .map(
              (smp) => `<a class="sample" href="#/tape/${enc(name)}/run/${enc(file)}/ex/${enc(smp.exchangeId)}">${esc(smp.request)}${smp.at ? ` <span class="dim">at ${esc(smp.at)}</span>` : ""}${"original" in smp || "candidate" in smp ? `: <span class="o">${val(smp.original)}</span> → <span class="n">${val(smp.candidate)}</span>` : ""}${smp.note ? ` <span class="dim">(${esc(smp.note)})</span>` : ""} <span class="dim">[${esc(short(smp.exchangeId))}]</span></a>`,
            )
            .join("")}</div>`,
        )
        .join("");
      const errors = rt.errorGroups
        .map((e) => `<div class="group"><span class="at bad">error: ${esc(e.message)}</span><span class="count">×${fmt(e.count)}</span>${e.samples.map((smp) => `<a class="sample" href="#/tape/${enc(name)}/run/${enc(file)}/ex/${enc(smp.exchangeId)}">${esc(smp.request)} <span class="dim">[${esc(short(smp.exchangeId))}]</span></a>`).join("")}</div>`)
        .join("");
      const skipped = Object.entries(rt.skipReasons).map(([why, n]) => `<div class="ignored">skipped ×${fmt(n)}: ${esc(why)}</div>`).join("");
      const ignored = rt.ignored.length ? `<div class="ignored">ignored: ${rt.ignored.map((g) => `<code>${esc(g.at)}</code> ×${fmt(g.count)} (${REASONS[g.reason] || g.reason})`).join(", ")}</div>` : "";
      const counts = [rt.identical && `${fmt(rt.identical)} identical`, rt.different && `${fmt(rt.different)} different`, rt.errors && plural(rt.errors, "error"), rt.skipped && `${fmt(rt.skipped)} skipped`].filter(Boolean).join(" · ");
      const body = groups + errors + skipped + ignored;
      return `<details class="route" ${bad ? "open" : ""}><summary><span class="${bad ? "bad" : rt.identical ? "good" : "dim"}">${bad ? "✗" : rt.identical ? "✓" : "–"}</span><span class="r">${esc(rt.route)}</span><span class="c">${counts}</span></summary>${body || '<div class="ignored">Every exchange on this route matches.</div>'}</details>`;
    })
    .join("");
  const ms = (n) => (n >= 100 ? `${Math.round(n)}ms` : `${Math.round(n * 100) / 100}ms`);
  return `<div class="crumbs"><a href="#/">Tapes</a> / <a href="#/tape/${enc(name)}">${esc(name)}</a> /</div>
    <h1>Run ${esc(new Date(r.startedAt).toLocaleString())}</h1>
    <p class="sub">Replayed against <code>${esc(r.against)}</code> · <code>${esc(r.run)}</code>${r.noise ? " · learned noise applied" : ""}</p>
    ${verdict(s)}
    <div class="stats">
      <div class="stat"><div class="v good">${fmt(s.identical)}</div><div class="k">identical</div></div>
      <div class="stat"><div class="v ${s.different ? "bad" : ""}">${fmt(s.different)}</div><div class="k">different</div></div>
      <div class="stat"><div class="v ${s.errors ? "bad" : ""}">${fmt(s.errors)}</div><div class="k">errors</div></div>
      <div class="stat"><div class="v">${fmt(s.skipped)}</div><div class="k">skipped</div></div>
      ${lat.original && lat.candidate && lat.candidate.count >= 20 ? `<div class="stat"><div class="v">${ms(lat.original.p50)} → ${ms(lat.candidate.p50)}</div><div class="k">p50 recorded → candidate</div></div>` : ""}
    </div>
    ${replayed ? `<div class="bar-h" role="img" aria-label="${fmt(s.identical)} identical, ${fmt(s.different)} different, ${fmt(s.errors)} errors"><i style="width:${pct(s.identical)}%;background:var(--good)"></i><i style="width:${pct(s.different)}%;background:var(--bad)"></i><i style="width:${pct(s.errors)}%;background:var(--warn)"></i></div>` : ""}
    <h2>Routes</h2>${routes}`;
}

// JSON with the places that differ highlighted. Paths are written like the report: $.items[2].total.
function childPath(path, key) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}
function scalar(v) {
  if (typeof v === "string") return `<span class="str">${esc(JSON.stringify(v))}</span>`;
  if (typeof v === "number") return `<span class="num">${v}</span>`;
  return `<span class="lit">${esc(JSON.stringify(v))}</span>`;
}
function renderJson(value, marks) {
  const lines = [];
  const push = (html, cls) => lines.push(cls ? `<span class="${cls}">${html}</span>` : html);
  const walk = (v, path, indent, key, comma, inherited) => {
    const cls = marks.get(path) || inherited;
    const label = key === null ? "" : `<span class="k">${esc(JSON.stringify(key))}</span>: `;
    const c = comma ? "," : "";
    if (v !== null && typeof v === "object") {
      const arr = Array.isArray(v);
      const entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
      if (entries.length === 0) return push(`${indent}${label}${arr ? "[]" : "{}"}${c}`, cls);
      push(`${indent}${label}${arr ? "[" : "{"}`, cls);
      entries.forEach(([k, x], i) => walk(x, arr ? `${path}[${k}]` : childPath(path, k), `${indent}  `, arr ? null : k, i < entries.length - 1, cls));
      return push(`${indent}${arr ? "]" : "}"}${c}`, cls);
    }
    push(`${indent}${label}${scalar(v)}${c}`, cls);
  };
  walk(value, "$", "", null, false, "");
  return lines.join("\n");
}
function decodeBody(body) {
  if (!body) return { kind: "empty" };
  if (body.encoding === "base64") return { kind: "binary", text: `(${Math.floor((body.data.length * 3) / 4)} bytes, binary or compressed)` };
  try {
    return { kind: "json", value: JSON.parse(body.data) };
  } catch {
    return { kind: "text", text: body.data };
  }
}
function marksFor(c, prefix) {
  const m = new Map();
  for (const x of c.ignored) if (x.at.startsWith(`${prefix} $`)) m.set(x.at.slice(prefix.length + 1), "hl-ok");
  for (const x of c.mismatches) if (x.at.startsWith(`${prefix} $`)) m.set(x.at.slice(prefix.length + 1), "hl");
  return m;
}
function bodyPane(title, res, marks, sideNote) {
  const b = decodeBody(res.body);
  const content = b.kind === "json" ? renderJson(b.value, marks) : b.kind === "empty" ? '<span class="dim">(empty body)</span>' : esc(b.text);
  const ct = Object.entries(res.headers).find(([k]) => k.toLowerCase() === "content-type");
  return `<div class="pane"><h3>${esc(title)} <span class="s">${res.status}${ct ? ` · ${esc(ct[1])}` : ""}${sideNote ? ` · ${sideNote}` : ""}</span></h3><pre class="json">${content}</pre></div>`;
}
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
function effectsPane(title, effects, marks) {
  if (!effects) return `<div class="pane"><h3>${esc(title)}</h3><div class="effects dim">Not reported (no gerra SDK on this side)</div></div>`;
  // Effects are compared in any order, sorted the same way as here, so the highlighted indices line up.
  const sorted = [...effects].sort((a, b) => (canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0));
  return `<div class="pane"><h3>${esc(title)} <span class="s">${plural(effects.length, "effect")}</span></h3><pre class="json">${renderJson(sorted, marks)}</pre></div>`;
}

async function exchangePage(name, file, id) {
  const c = await api(`tapes/${enc(name)}/runs/${enc(file)}/exchanges/${enc(id)}`);
  const q = c.request.query ? `?${c.request.query}` : "";
  const bodyMarks = marksFor(c, "body");
  const effectMarks = marksFor(c, "effects");
  const status =
    c.outcome !== "replayed"
      ? `<span class="verdict bad">✗ ${esc(c.outcome)}${c.error ? `: ${esc(c.error)}` : ""}${c.reason ? `: ${esc(c.reason)}` : ""}</span>`
      : c.mismatches.length === 0
        ? '<span class="verdict ok">✓ Equivalent</span>'
        : `<span class="verdict bad">✗ ${plural(c.mismatches.length, "difference")}</span>`;
  const req = decodeBody(c.request.body);
  const mism = c.mismatches.length
    ? `<h2>Differences</h2><ul class="mism">${c.mismatches.map((m) => `<li><span class="bad">✗</span> <b>${esc(m.at)}</b>: <span class="bad">${val(m.original)}</span> → <span class="good">${val(m.candidate)}</span>${m.note ? ` <span class="dim">(${esc(m.note)})</span>` : ""}</li>`).join("")}</ul>`
    : "";
  const ign = c.ignored.length ? `<h2>Ignored</h2><ul class="mism">${c.ignored.map((m) => `<li><span class="dim">${esc(m.at)}</span>: ${val(m.original)} → ${val(m.candidate)} <span class="tag">${REASONS[m.ignored] || m.ignored}</span></li>`).join("")}</ul>` : "";
  const hasEffects = c.recorded.effects || (c.candidate && c.candidate.effects);
  return `<div class="crumbs"><a href="#/">Tapes</a> / <a href="#/tape/${enc(name)}">${esc(name)}</a> / <a href="#/tape/${enc(name)}/run/${enc(file)}">run</a> /</div>
    <h1>${esc(c.request.method)} ${esc(c.request.path + q)}</h1>
    <p class="sub">route <code>${esc(c.route)}</code> · <code>${esc(c.id)}</code></p>
    ${status}
    ${mism}
    ${req.kind !== "empty" ? `<h2>Request body</h2><div class="pane"><pre class="json">${req.kind === "json" ? renderJson(req.value, new Map()) : esc(req.text)}</pre></div>` : ""}
    <h2>Responses</h2>
    <div class="split">${bodyPane("Recorded (original)", c.recorded, bodyMarks)}${c.candidate ? bodyPane("Candidate (rewrite)", c.candidate, bodyMarks) : `<div class="pane"><h3>Candidate</h3><pre class="json dim">${esc(c.outcome)}</pre></div>`}</div>
    ${hasEffects ? `<h2>Side effects <span class="dim" style="text-transform:none;letter-spacing:0">(compared in any order)</span></h2><div class="split">${effectsPane("Recorded", c.recorded.effects, effectMarks)}${effectsPane("Candidate", c.candidate && c.candidate.effects, effectMarks)}</div>` : ""}
    ${ign}`;
}

async function livePage() {
  const sessions = await api("live");
  if (sessions.length === 0) {
    return `<h1>Live</h1><p class="sub">Shadow and cutover sessions started from this directory show up here.</p>
      <div class="empty">Mirror live traffic to the rewrite without affecting users:<br><br><code>npx @gerra/cli shadow --primary :3000 --candidate :4000 --port 8080</code><br><br>then shift traffic over gradually with automatic rollback:<br><br><code>npx @gerra/cli cutover --primary :3000 --candidate :4000 --port 8080</code></div>`;
  }
  const blocks = sessions
    .map(({ kind, alive, state: st }) => {
      const pill = alive ? '<span class="pill live">● live</span>' : '<span class="pill">stopped</span>';
      if (kind === "shadow") {
        const c = st.counts;
        const routes = st.routes
          .map((r) => `<tr><td><code>${esc(r.route)}</code></td><td class="n">${fmt(r.compared)}</td><td class="n">${fmt(r.identical)}</td><td class="n ${r.different ? "bad" : ""}">${fmt(r.different)}</td><td class="n">${fmt(r.candidateErrors)}</td><td class="mono dim">${r.mismatches.slice(0, 3).map((m) => `${esc(m.at)} ×${m.count}`).join("<br>")}</td></tr>`)
          .join("");
        const recent = (st.recent || []).slice(-8).reverse().map((e) => `<li><span class="bad">✗</span> ${esc(e.request)} ${e.error ? `<span class="dim">${esc(e.error)}</span>` : (e.mismatches || []).slice(0, 2).map((m) => `<span class="dim">${esc(m.at)}:</span> ${val(m.original)} → ${val(m.candidate)}`).join("; ")}</li>`).join("");
        return `<h2>Shadow · ${esc(st.name)} ${pill}</h2>
          <p class="sub">${esc(st.listen)} → users get <code>${esc(st.primary)}</code>, mirrored to <code>${esc(st.candidate)}</code> · started ${when(st.startedAt)} · updated ${when(st.updatedAt)}</p>
          <div class="stats"><div class="stat"><div class="v">${fmt(c.requests)}</div><div class="k">requests</div></div><div class="stat"><div class="v">${fmt(c.compared)}</div><div class="k">compared</div></div><div class="stat"><div class="v good">${fmt(c.identical)}</div><div class="k">identical</div></div><div class="stat"><div class="v ${c.different ? "bad" : ""}">${fmt(c.different)}</div><div class="k">different</div></div><div class="stat"><div class="v ${c.candidateErrors ? "bad" : ""}">${fmt(c.candidateErrors)}</div><div class="k">candidate errors</div></div></div>
          ${routes ? `<table><thead><tr><th>Route</th><th class="n">Compared</th><th class="n">Identical</th><th class="n">Different</th><th class="n">Errors</th><th>Top differences</th></tr></thead><tbody>${routes}</tbody></table>` : ""}
          ${recent ? `<h2>Recent differences</h2><ul class="mism">${recent}</ul>` : ""}`;
      }
      const sp = st.step;
      const phase = st.phase === "rolled_back" ? `<span class="verdict bad">✗ rolled back at ${st.rollback ? st.rollback.atWeight : st.weight}%: ${esc(st.rollback ? st.rollback.reason : "")}</span>` : st.phase === "complete" ? '<span class="verdict ok">✓ complete: candidate serves 100%</span>' : `<span class="verdict none">→ candidate serves ${st.weight}% (step ${st.stepIndex + 1} of ${st.steps.length})</span>`;
      const steps = st.steps.map((w, i) => `<span class="pill" style="${i < st.stepIndex || st.phase === "complete" ? "color:var(--good)" : i === st.stepIndex && st.phase === "stepping" ? "color:var(--text);border-color:var(--text)" : ""}">${w}%</span>`).join(" ");
      const events = st.events.slice(-10).reverse().map((e) => `<li>${when(e.time)} · ${esc(e.type)} ${e.weight}%${e.reason ? ` <span class="dim">${esc(e.reason)}</span>` : ""}</li>`).join("");
      return `<h2>Cutover · ${esc(st.name)} ${pill}</h2>
        <p class="sub">${esc(st.listen)} → <code>${esc(st.primary)}</code> / <code>${esc(st.candidate)}</code> · started ${when(st.startedAt)} · updated ${when(st.updatedAt)}</p>
        ${phase}<p>${steps}</p>
        <div class="stats"><div class="stat"><div class="v">${fmt(sp.servedCandidate)}</div><div class="k">served by candidate (step)</div></div><div class="stat"><div class="v">${fmt(sp.servedPrimary)}</div><div class="k">served by primary (step)</div></div><div class="stat"><div class="v">${fmt(sp.compared)}</div><div class="k">compared</div></div><div class="stat"><div class="v ${sp.different ? "bad" : ""}">${fmt(sp.different)}</div><div class="k">different</div></div><div class="stat"><div class="v ${sp.candidateErrors ? "bad" : ""}">${fmt(sp.candidateErrors)}</div><div class="k">candidate errors</div></div></div>
        ${events ? `<h2>Events</h2><ul class="mism">${events}</ul>` : ""}`;
    })
    .join("");
  return `<h1>Live</h1><p class="sub">Refreshes every 2 seconds.</p>${blocks}`;
}

// ---------------------------------------------------------------------------------------------
// Router

async function route() {
  clearTimeout(refreshTimer);
  tip.hidden = true;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", (a.dataset.nav === "live") === (parts[0] === "live")));
  const live = parts[0] === "live";
  try {
    let html;
    if (live) html = await livePage();
    else if (parts[0] === "tape" && parts[2] === "run" && parts[4] === "ex") html = await exchangePage(parts[1], parts[3], parts[5]);
    else if (parts[0] === "tape" && parts[2] === "run") html = await runPage(parts[1], parts[3]);
    else if (parts[0] === "tape") html = await tapePage(parts[1]);
    else html = await tapesPage();
    app.innerHTML = html;
    document.title = `${(app.querySelector("h1")?.textContent || "gerra").trim()} · gerra`;
  } catch (err) {
    app.innerHTML = `<h1>Something went wrong</h1><p class="err">${esc(err.message)}</p><p><a href="#/">Back to tapes</a></p>`;
  }
  bindTips(app);
  app.querySelectorAll("tr[data-href]").forEach((tr) => tr.addEventListener("click", (e) => { if (!e.target.closest("a")) location.hash = tr.dataset.href; }));
  if (live) refreshTimer = setTimeout(route, 2000);
}

window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
route();
