const AGENTS = [
  "scanner",
  "mutator",
  "gatekeeper",
  "flag",
  "traffic",
  "analyst",
  "approval",
  "rollout",
];

const SPEC_ID_RE = /^[a-z0-9-]{1,40}$/;

const agentsEl = document.getElementById("agents");
const logEl = document.getElementById("log");
const variantsEl = document.getElementById("variants");
const resultsEl = document.getElementById("results");
const phaseEl = document.getElementById("phase");

function lastEvent(events, agent) {
  return [...events].reverse().find((item) => item.agent === agent);
}

function setText(el, value) {
  el.textContent = value == null ? "" : String(value);
}

function renderAgents(state) {
  agentsEl.replaceChildren();
  for (const name of AGENTS) {
    const event = lastEvent(state.events || [], name);
    const kind = event?.kind || "idle";
    const card = document.createElement("div");
    card.className = `agent ${kind}`;
    const nameEl = document.createElement("div");
    nameEl.className = "name";
    setText(nameEl, name);
    const stepEl = document.createElement("div");
    stepEl.className = "step";
    setText(stepEl, event ? event.message : "—");
    card.append(nameEl, stepEl);
    agentsEl.append(card);
  }
}

function renderLog(events) {
  logEl.replaceChildren();
  for (const event of (events || []).slice(-200)) {
    const li = document.createElement("li");
    li.className = event.kind;
    const agent = document.createElement("span");
    agent.className = "agent";
    setText(agent, event.agent);
    li.append(agent, document.createTextNode(` ${event.kind} — ${event.message}`));
    logEl.append(li);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

function lastGeneration(state) {
  const gens = state.generations || [];
  return gens[gens.length - 1];
}

function renderVariants(state) {
  variantsEl.replaceChildren();
  const gen = lastGeneration(state);
  const rows = gen?.gated || [];
  for (const row of rows) {
    const tr = document.createElement("tr");
    const spec = document.createElement("td");
    const specId = SPEC_ID_RE.test(row.specId || "") ? row.specId : "(invalid spec id)";
    setText(spec, specId);
    const gate = document.createElement("td");
    const pill = document.createElement("span");
    pill.className = `pill ${row.passed ? "pass" : "reject"}`;
    setText(pill, row.passed ? "PASS" : "REJECT");
    gate.append(pill);
    const baseline = document.createElement("td");
    setText(baseline, row.baseline?.violationCount ?? "—");
    const after = document.createElement("td");
    setText(after, row.after?.violationCount ?? "—");
    const reason = document.createElement("td");
    setText(reason, row.reason);
    tr.append(spec, gate, baseline, after, reason);
    variantsEl.append(tr);
  }
}

function renderResults(state) {
  const rec = state.recommendation || lastGeneration(state)?.recommendation;
  const flag = state.flag || lastGeneration(state)?.flag;
  setText(document.getElementById("flag-id"), flag ? `${flag.flagName} (#${flag.flagId})` : "—");
  setText(document.getElementById("exp-id"), flag ? String(flag.experimentId) : "—");
  setText(document.getElementById("metric-id"), flag ? String(flag.metricId) : "—");
  if (state.timeSaved) {
    const minutes = (state.timeSaved.savedMs / 60000).toFixed(1);
    setText(
      document.getElementById("time-saved"),
      `${minutes} min vs est. manual 115 min (itemised estimate)`,
    );
  }
  resultsEl.replaceChildren();
  if (!rec) {
    setText(resultsEl, "Waiting for experiment results…");
    return;
  }
  const summary = document.createElement("p");
  if (rec.kind === "winner") {
    setText(
      summary,
      `Winner ${rec.arm} at ${((rec.chanceToWin || 0) * 100).toFixed(1)}% (threshold ${((rec.threshold || 0) * 100).toFixed(0)}%).`,
    );
  } else {
    setText(summary, rec.reason || "Keep collecting");
  }
  resultsEl.append(summary);
  for (const arm of rec.arms || []) {
    const line = document.createElement("p");
    const pct = Math.round((arm.chanceToWin || 0) * 100);
    setText(line, `${arm.key} n=${arm.n ?? "—"} sum=${arm.sum ?? "—"} chance_to_win=${pct}%`);
    const bar = document.createElement("div");
    bar.className = "bar";
    const span = document.createElement("span");
    span.style.width = `${pct}%`;
    bar.append(span);
    resultsEl.append(line, bar);
  }
}

function render(state) {
  const phase = state.phase || "idle";
  setText(phaseEl, `phase: ${phase}`);
  phaseEl.className = `phase ${phase === "WAITING_FOR_HUMAN_APPROVAL" || phase === "KEEP_COLLECTING" ? "wait" : phase}`;
  renderAgents(state);
  renderLog(state.events || []);
  renderVariants(state);
  renderResults(state);
}

async function poll() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    if (res.ok) render(await res.json());
  } catch {
    /* keep last frame */
  }
}

const stream = new EventSource("/api/stream");
stream.onmessage = (message) => {
  try {
    const payload = JSON.parse(message.data);
    render(payload.state || payload);
  } catch {
    /* ignore */
  }
};
setInterval(poll, 1500);
poll();
