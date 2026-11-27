import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EVENTS_PATH, LIVE_PATH } from "./paths.ts";
import { redactRecord } from "./secrets.ts";
import type { AgentName, EventKind, OrchEvent, PersistedState, Phase } from "./types.ts";
import { assertNever } from "./types.ts";

const RESET = "\x1b[0m";

function agentColor(agent: AgentName): string {
  switch (agent) {
    case "conductor":
      return "\x1b[1m";
    case "scanner":
      return "\x1b[36m";
    case "mutator":
      return "\x1b[35m";
    case "gatekeeper":
      return "\x1b[33m";
    case "flag":
      return "\x1b[34m";
    case "traffic":
      return "\x1b[37m";
    case "analyst":
      return "\x1b[32m";
    case "approval":
      return "\x1b[93m";
    case "rollout":
      return "\x1b[92m";
    default: {
      const _exhaustive: never = agent;
      return assertNever(_exhaustive, "unhandled agent");
    }
  }
}

function kindTag(kind: EventKind): string {
  switch (kind) {
    case "start":
      return "START";
    case "info":
      return "info ";
    case "warn":
      return "WARN ";
    case "pass":
      return "PASS ";
    case "reject":
      return "REJECT";
    case "wait":
      return "WAIT ";
    case "done":
      return "DONE ";
    case "error":
      return "ERROR";
    default: {
      const _exhaustive: never = kind;
      return assertNever(_exhaustive, "unhandled event kind");
    }
  }
}

export function formatTerminal(event: OrchEvent): string {
  const color = agentColor(event.agent);
  const pad = event.agent.padEnd(10);
  return `${color}[${pad}] ${kindTag(event.kind)}${RESET} ${event.message}`;
}

export type EventListener = (event: OrchEvent, all: OrchEvent[]) => void;

export class EventLog {
  readonly events: OrchEvent[] = [];
  phase: Phase = "idle";
  private seq = 0;
  private readonly listeners = new Set<EventListener>();
  snapshot: Omit<PersistedState, "events" | "phase"> | Record<string, unknown> = {};

  constructor(private readonly persist = true) {}

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setPhase(phase: Phase): void {
    this.phase = phase;
    this.writeLive();
  }

  emit(
    agent: AgentName,
    kind: EventKind,
    message: string,
    data?: Record<string, unknown>,
  ): OrchEvent {
    const event: OrchEvent = {
      ts: new Date().toISOString(),
      seq: ++this.seq,
      agent,
      kind,
      message,
      data: redactRecord(data),
    };
    this.events.push(event);
    process.stdout.write(`${formatTerminal(event)}\n`);
    if (this.persist) {
      mkdirSync(dirname(EVENTS_PATH), { recursive: true });
      appendFileSync(EVENTS_PATH, `${JSON.stringify(event)}\n`);
    }
    this.writeLive();
    for (const listener of this.listeners) listener(event, this.events);
    return event;
  }

  livePayload(): Record<string, unknown> {
    return {
      phase: this.phase,
      events: this.events,
      ...this.snapshot,
    };
  }

  writeLive(): void {
    if (!this.persist) return;
    mkdirSync(dirname(LIVE_PATH), { recursive: true });
    writeFileSync(LIVE_PATH, `${JSON.stringify(this.livePayload(), null, 2)}\n`);
  }
}
