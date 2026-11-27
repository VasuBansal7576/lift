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

const agentsEl = document.getElementById("agents");
const logEl = document.getElementById("log");
const variantsEl = document.getElementById("variants");
const resultsEl = document.getElementById("results");
const phaseEl = document.getElementById("phase");

function lastEvent(events, agent) {
  return [...events].reverse().find((item) => item.agent === agent);
}

function renderAgents(state) {
  agentsEl.innerHTML = AGENTS.map((name) => {
    const event = lastEvent(state.events || [], name);
    const kind = event?.kind || "idle";
    return `<div class="agent ${kind}"><div class="name">${name}</div><div class="step">${event ? event.message : "—"}</div></div>`;
  }).join("");
}

function renderLog(events) {
  logEl.innerHTML = (events || [])
    .slice(-200)
    .map(
      (event) =>
        `<li class="${event.kind}"><span class="agent">${event.agent}</span> ${event.kind} — ${event.message}</li>`,
    )
    .join("");
  logEl.scrollTop = logEl.scrollHeight;
}

function lastGeneration(state) {
  const gens = state.generations || [];
  return gens[gens.length - 1];
}

function renderVariants(state) {
  const gen = lastGeneration(state);
  const rows = gen?.gated || [];
  variantsEl.innerHTML = rows
    .map((row) => {
      const pill = row.passed ? "pass" : "reject";
      return `<tr>
        <td>${row.specId}</td>
        <td><span class="pill ${pill}">${row.passed ? "PASS" : "REJECT"}</span></td>
        <td>${row.baseline?.violationCount ?? "—"}</td>
        <td>${row.after?.violationCount ?? "—"}</td>
        <td>${row.reason}</td>
      </tr>`;
    })
    .join("");
}

function renderResults(state) {
  const rec = state.recommendation || lastGeneration(state)?.recommendation;
  const flag = state.flag || lastGeneration(state)?.flag;
  document.getElementById("flag-id").textContent = flag ? `${flag.flagName} (#${flag.flagId})` : "—";
  document.getElementById("exp-id").textContent = flag ? String(flag.experimentId) : "—";
  document.getElementById("metric-id").textContent = flag ? String(flag.metricId) : "—";
  if (state.timeSaved) {
    const minutes = (state.timeSaved.savedMs / 60000).toFixed(1);
    document.getElementById("time-saved").textContent = `${minutes} min vs ${state.timeSaved.manualEstimateMinutes} min manual`;
  }
  if (!rec) {
    resultsEl.textContent = "Waiting for experiment results…";
    return;
  }
  const arms = rec.arms || [];
  resultsEl.innerHTML =
    (rec.kind === "winner"
      ? `<p>Winner <strong>${rec.arm}</strong> at ${(rec.chanceToWin * 100).toFixed(1)}% (threshold ${(rec.threshold * 100).toFixed(0)}%).</p>`
      : `<p>${rec.reason || "Keep collecting"}</p>`) +
    arms
      .map((arm) => {
        const pct = Math.round((arm.chanceToWin || 0) * 100);
        return `<p>${arm.key} n=${arm.n ?? "—"} sum=${arm.sum ?? "—"} chance_to_win=${pct}%</p><div class="bar"><span style="width:${pct}%"></span></div>`;
      })
      .join("");
}

function render(state) {
  const phase = state.phase || "idle";
  phaseEl.textContent = `phase: ${phase}`;
  phaseEl.className = `phase ${phase === "WAITING_FOR_HUMAN_APPROVAL" ? "wait" : phase}`;
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
