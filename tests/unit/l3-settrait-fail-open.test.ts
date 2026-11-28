import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";

class FakeClassList {
  readonly values = new Set<string>();
  add(...names: string[]) {
    for (const name of names) this.values.add(name);
  }
  remove(...names: string[]) {
    for (const name of names) this.values.delete(name);
  }
  contains(name: string) {
    return this.values.has(name);
  }
  toString() {
    return [...this.values].join(" ");
  }
}

type FakeNode = {
  id: string;
  tagName: string;
  type?: string;
  className: string;
  classList: FakeClassList;
  hidden: boolean;
  dataset: Record<string, string>;
  style: {
    setProperty: (k: string, v: string) => void;
    removeProperty: (k: string) => void;
    transform: string;
    props: Record<string, string>;
  };
  textContent: string;
  parentNode: FakeNode | null;
  children: FakeNode[];
  attributes: Map<string, string>;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  hasAttribute: (k: string) => boolean;
    appendChild: (child: FakeNode) => FakeNode;
    replaceChildren: (...nodes: FakeNode[]) => void;
    append: (...nodes: Array<FakeNode | string>) => void;
  contains: (other: FakeNode) => boolean;
  removeChild: (child: FakeNode) => FakeNode;
  closest: (sel: string) => FakeNode | null;
  addEventListener: () => void;
  removeEventListener: () => void;
  dispatchEvent: () => boolean;
  focus: () => void;
  querySelector: (sel: string) => FakeNode | null;
  querySelectorAll: (sel: string) => FakeNode[];
};

function fakeEl(tag = "div", id = ""): FakeNode {
  const styleProps: Record<string, string> = {};
  const node: FakeNode = {
    id,
    tagName: tag.toUpperCase(),
    className: "",
    classList: new FakeClassList(),
    hidden: false,
    dataset: {},
    style: {
      props: styleProps,
      transform: "",
      setProperty(k: string, v: string) {
        styleProps[k] = v;
      },
      removeProperty(k: string) {
        delete styleProps[k];
      },
    },
    textContent: "",
    parentNode: null,
    children: [],
    attributes: new Map<string, string>(),
    setAttribute(k: string, v: string) {
      this.attributes.set(k, v);
      if (k === "id") this.id = v;
      if (k === "hidden") this.hidden = true;
    },
    getAttribute(k: string) {
      return this.attributes.get(k) ?? null;
    },
    removeAttribute(k: string) {
      this.attributes.delete(k);
      if (k === "hidden") this.hidden = false;
    },
    hasAttribute(k: string) {
      return this.attributes.has(k);
    },
    appendChild(child: FakeNode) {
      this.children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child: FakeNode) {
      this.children = this.children.filter((node) => node !== child);
      child.parentNode = null;
      return child;
    },
    replaceChildren(...nodes: FakeNode[]) {
      this.children = [];
      this.textContent = "";
      for (const child of nodes) this.appendChild(child);
    },
    append(...nodes: Array<FakeNode | string>) {
      for (const item of nodes) {
        if (typeof item === "string") this.textContent += item;
        else this.appendChild(item);
      }
    },
    contains(other: FakeNode) {
      if (other === this) return true;
      return this.children.some((child) => child.contains(other));
    },
    closest() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    focus() {},
    querySelector(sel: string) {
      return queryAll(this, sel)[0] ?? null;
    },
    querySelectorAll(sel: string) {
      return queryAll(this, sel);
    },
  };
  return node;
}

function queryAll(root: FakeNode, sel: string): FakeNode[] {
  const out: FakeNode[] = [];
  const walk = (node: FakeNode) => {
    if (matches(node, sel)) out.push(node);
    for (const child of node.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return out;
}

function matches(node: FakeNode, sel: string): boolean {
  if (sel.startsWith("#")) return node.id === sel.slice(1);
  if (sel.startsWith(".")) return node.classList.contains(sel.slice(1));
  if (sel.includes("[")) {
    const attr = sel.replace(/[[\]]/g, "").split(",")[0] ?? "";
    if (attr.startsWith("data-")) return attr.replace("data-", "") in node.dataset || node.attributes.has(attr);
    return node.attributes.has(attr);
  }
  if (sel.includes(",")) {
    return sel.split(",").some((part) => matches(node, part.trim()));
  }
  return node.tagName === sel.toUpperCase();
}

async function loadRuntime() {
  const html = fakeEl("html");
  const body = fakeEl("body");
  const masthead = fakeEl("div");
  masthead.className = "masthead";
  masthead.classList.add("masthead");
  const hud = fakeEl("div", "lift-l3-hud");
  const offline = fakeEl("p", "lift-l3-offline");
  offline.hidden = true;
  const optOut = fakeEl("button", "lift-l3-opt-out");
  optOut.type = "button";
  const optIn = fakeEl("button", "lift-l3-opt-in");
  optIn.type = "button";
  const main = fakeEl("main");
  body.appendChild(masthead);
  body.appendChild(hud);
  body.appendChild(offline);
  body.appendChild(main);
  masthead.appendChild(optOut);
  masthead.appendChild(optIn);
  html.appendChild(body);

  const byId = new Map<string, FakeNode>([
    ["lift-l3-hud", hud],
    ["lift-l3-offline", offline],
    ["lift-l3-opt-out", optOut],
    ["lift-l3-opt-in", optIn],
  ]);

  const store = new Map<string, string>();
  const document = {
    documentElement: html,
    body,
    readyState: "complete",
    cookie: "",
    activeElement: html,
    defaultView: null as unknown,
    getElementById(id: string) {
      return byId.get(id) ?? null;
    },
    createElement(tag: string) {
      const node = fakeEl(tag);
      if (tag === "button") node.type = "button";
      const origSet = node.setAttribute.bind(node);
      node.setAttribute = (k: string, v: string) => {
        origSet(k, v);
        if (k === "id") byId.set(v, node);
      };
      return node;
    },
    querySelector(sel: string) {
      if (sel === ".masthead") return masthead;
      if (sel === "main") return main;
      if (sel.startsWith("#")) return byId.get(sel.slice(1)) ?? null;
      return html.querySelector(sel);
    },
    querySelectorAll(sel: string) {
      return html.querySelectorAll(sel);
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  };
  document.defaultView = { location: { search: "" } };

  const windowObj = {
    LiftL3: undefined as unknown,
    __LIFT_L3_NO_AUTO__: true,
    document,
    location: { search: "" },
    sessionStorage: {
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, String(value));
      },
      removeItem(key: string) {
        store.delete(key);
      },
    },
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    requestAnimationFrame(cb: (t: number) => void) {
      return globalThis.setTimeout(() => cb(Date.now()), 16);
    },
    cancelAnimationFrame(id: number) {
      globalThis.clearTimeout(id);
    },
    CustomEvent: class CustomEvent extends Event {
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        super(type);
        this.detail = init?.detail;
      }
    },
  };

  const fetchStub = async (input: unknown) => {
    if (String(input).includes("config.json")) {
      return {
        ok: true,
        async json() {
          return {
            flagsmithEnvironmentKey: "test-env-key",
            flagsmithApiUrl: "http://127.0.0.1:8000/api/v1/",
          };
        },
      };
    }
    return { ok: false, async json() { return {}; } };
  };

  Object.assign(globalThis, {
    window: windowObj,
    document,
    location: windowObj.location,
    sessionStorage: windowObj.sessionStorage,
    CustomEvent: windowObj.CustomEvent,
    fetch: fetchStub,
    __LIFT_L3_NO_AUTO__: true,
  });
  (windowObj as { fetch?: typeof fetchStub }).fetch = fetchStub;

  const mod = await import("../../runtime/l3-balancer.js");
  return { ...mod, html, hud, windowObj };
}

describe("L3 setTrait reject fail-open", () => {
  afterEach(() => {
    const runtime = (
      globalThis as { window?: { LiftL3?: { stop?: () => void } } }
    ).window?.LiftL3;
    runtime?.stop?.();
  });

  it("keeps the catch path from applying Sensory-Safe locally", () => {
    const src = readFileSync(resolve(ROOT, "runtime/l3-balancer.js"), "utf8");
    expect(src).toMatch(
      /catch \{\s*if \(seq !== runtime\.traitSeq\) return;\s*runtime\.traitInFlight = false;\s*applySensorySafe\(false/,
    );
    expect(src).not.toMatch(/applySensorySafe\(\s*true\s*,\s*runtime\.flagConfig\s*\)/);
  });

  it("does not apply Sensory-Safe when setTrait rejects", async () => {
    const { applySensorySafe, pushTrait, getRuntime, html } = await loadRuntime();
    applySensorySafe(true);
    expect(html.classList.contains("lift-sensory-safe")).toBe(true);

    const runtime = getRuntime() as {
      flagsmith: unknown;
      offline: boolean;
      hysteresis: { overstimulated: boolean };
    };
    runtime.offline = false;
    runtime.hysteresis.overstimulated = true;
    runtime.flagsmith = {
      async setTrait() {
        throw new Error("Flagsmith setTrait rejected");
      },
      getTrait() {
        return false;
      },
      hasFeature() {
        return false;
      },
      getValue() {
        return null;
      },
    };

    await pushTrait(true);
    expect(html.classList.contains("lift-sensory-safe")).toBe(false);
    expect(runtime.offline).toBe(false);
  });
});

type TestRuntime = {
  started: boolean;
  initGen: number;
  startGen: number;
  flagsmith: unknown;
  offline: boolean;
  hysteresis: { overstimulated: boolean };
  reconnectTimer: number;
  reconnectRetries: number;
  timer: number;
  lastScore: number;
  biometric: number;
  importSdk?: (() => Promise<{ default: unknown }>) | null;
};

async function waitForInitGen(
  getRuntime: () => TestRuntime,
  min: number,
  ms = 2_000,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (getRuntime().initGen >= min) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`initGen stayed at ${getRuntime().initGen}, expected >= ${min}`);
}

function gatedSdk(gate: Promise<void>, traitOn: boolean) {
  return async () => ({
    default: {
      async init() {
        await gate;
      },
      getTrait() {
        return traitOn;
      },
      hasFeature() {
        return traitOn;
      },
      getValue() {
        return JSON.stringify({
          pauseMedia: true,
          pauseMotion: true,
          softenContrast: true,
          showSummaries: true,
          hideMarketing: true,
        });
      },
      async setTrait() {},
      async getFlags() {},
    },
  });
}

function resetRuntime(
  getRuntime: () => TestRuntime,
  initialHysteresis: () => { overstimulated: boolean },
) {
  const runtime = getRuntime();
  runtime.flagsmith = null;
  runtime.offline = false;
  runtime.initGen = 0;
  runtime.startGen = 0;
  runtime.importSdk = null;
  runtime.hysteresis = initialHysteresis();
  runtime.started = false;
  runtime.reconnectTimer = 0;
  runtime.reconnectRetries = 0;
  runtime.timer = 0;
}

describe("L3 init generation ignores stale Flagsmith init", () => {
  afterEach(() => {
    const runtime = (
      globalThis as { window?: { LiftL3?: { stop?: () => void } } }
    ).window?.LiftL3;
    runtime?.stop?.();
  });

  it("does not mutate after stop() during initFlagsmith", async () => {
    const { start, stop, getRuntime, html, initialHysteresis } = await loadRuntime();
    resetRuntime(getRuntime as () => TestRuntime, initialHysteresis);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    (getRuntime() as TestRuntime).importSdk = gatedSdk(gate, true);

    const starting = start();
    await waitForInitGen(getRuntime as () => TestRuntime, 1);
    stop();
    release();
    await starting;

    const runtime = getRuntime() as TestRuntime;
    expect(runtime.started).toBe(false);
    expect(runtime.flagsmith).toBe(null);
    expect(runtime.hysteresis.overstimulated).toBe(false);
    expect(html.classList.contains("lift-sensory-safe")).toBe(false);
  });

  it("stop/start during recoverFlagsmith does not double-init stale state", async () => {
    const { start, stop, recoverFlagsmith, getRuntime, html, initialHysteresis } = await loadRuntime();
    resetRuntime(getRuntime as () => TestRuntime, initialHysteresis);
    (getRuntime() as TestRuntime).importSdk = async () => ({
      default: {
        async init() {
          throw new Error("Flagsmith down");
        },
        getTrait() {
          return false;
        },
        hasFeature() {
          return false;
        },
        getValue() {
          return "{}";
        },
        async setTrait() {},
        async getFlags() {},
      },
    });
    await start();
    const afterFail = getRuntime() as TestRuntime;
    expect(afterFail.started).toBe(true);
    expect(afterFail.offline).toBe(true);

    let releaseStale = () => {};
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let staleInitEntered = false;
    (getRuntime() as TestRuntime).importSdk = async () => ({
      default: {
        async init() {
          staleInitEntered = true;
          await staleGate;
        },
        getTrait() {
          return true;
        },
        hasFeature() {
          return true;
        },
        getValue() {
          return "{}";
        },
        async setTrait() {},
        async getFlags() {},
      },
    });

    const recovering = recoverFlagsmith();
    const waitEnter = Date.now();
    while (!staleInitEntered && Date.now() - waitEnter < 2_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!staleInitEntered) throw new Error("recoverFlagsmith did not enter flagsmith.init");

    (getRuntime() as TestRuntime).importSdk = gatedSdk(Promise.resolve(), false);
    stop();
    await start();
    releaseStale();
    await recovering;

    const runtime = getRuntime() as TestRuntime;
    expect(runtime.started).toBe(true);
    expect(html.classList.contains("lift-sensory-safe")).toBe(false);
    expect(runtime.hysteresis.overstimulated).toBe(false);
  });

  it("recoverFlagsmith bails when its init was abandoned", async () => {
    const { start, stop, recoverFlagsmith, getRuntime, html, initialHysteresis, windowObj } =
      await loadRuntime();
    resetRuntime(getRuntime as () => TestRuntime, initialHysteresis);
    (getRuntime() as TestRuntime).importSdk = async () => ({
      default: {
        async init() {
          throw new Error("Flagsmith down");
        },
        getTrait() {
          return false;
        },
        hasFeature() {
          return false;
        },
        getValue() {
          return "{}";
        },
        async setTrait() {},
        async getFlags() {},
      },
    });
    await start();
    const afterFail = getRuntime() as TestRuntime;
    expect(afterFail.started).toBe(true);
    expect(afterFail.offline).toBe(true);
    windowObj.clearTimeout(afterFail.reconnectTimer);
    afterFail.reconnectTimer = 0;
    const retries = afterFail.reconnectRetries;

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    (getRuntime() as TestRuntime).importSdk = async () => ({
      default: {
        async init() {
          entered = true;
          await gate;
        },
        getTrait() {
          return true;
        },
        hasFeature() {
          return true;
        },
        getValue() {
          return "{}";
        },
        async setTrait() {},
        async getFlags() {},
      },
    });

    const recovering = recoverFlagsmith();
    const waitEnter = Date.now();
    while (!entered && Date.now() - waitEnter < 2_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!entered) throw new Error("recoverFlagsmith did not enter flagsmith.init");

    stop();
    (getRuntime() as TestRuntime).started = true;
    release();
    await recovering;

    const runtime = getRuntime() as TestRuntime;
    expect(runtime.flagsmith).toBe(null);
    expect(runtime.reconnectTimer).toBe(0);
    expect(runtime.reconnectRetries).toBe(retries);
    expect(html.classList.contains("lift-sensory-safe")).toBe(false);
    expect(runtime.hysteresis.overstimulated).toBe(false);
  });

  it("start() keeps a tick timer when recoverFlagsmith's config fetch is abandoned", async () => {
    const { start, stop, recoverFlagsmith, getRuntime, initialHysteresis, windowObj } =
      await loadRuntime();
    resetRuntime(getRuntime as () => TestRuntime, initialHysteresis);
    (getRuntime() as TestRuntime).importSdk = async () => ({
      default: {
        async init() {
          throw new Error("Flagsmith down");
        },
        getTrait() {
          return false;
        },
        hasFeature() {
          return false;
        },
        getValue() {
          return "{}";
        },
        async setTrait() {},
        async getFlags() {},
      },
    });
    await start();
    const afterFail = getRuntime() as TestRuntime;
    expect(afterFail.started).toBe(true);
    expect(afterFail.offline).toBe(true);
    windowObj.clearTimeout(afterFail.reconnectTimer);
    afterFail.reconnectTimer = 0;

    let sdkLoads = 0;
    const importSdk = afterFail.importSdk;
    afterFail.importSdk = async () => {
      sdkLoads += 1;
      if (!importSdk) throw new Error("importSdk missing");
      return importSdk();
    };

    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let configEntered = false;
    const gatedFetch = async (input: unknown) => {
      if (String(input).includes("config.json")) {
        configEntered = true;
        await gate;
        return {
          ok: true,
          async json() {
            return {
              flagsmithEnvironmentKey: "test-env-key",
              flagsmithApiUrl: "http://127.0.0.1:8000/api/v1/",
            };
          },
        };
      }
      return { ok: false, async json() { return {}; } };
    };
    (globalThis as { fetch: typeof gatedFetch }).fetch = gatedFetch;
    (windowObj as unknown as { fetch: typeof gatedFetch }).fetch = gatedFetch;

    const recovering = recoverFlagsmith();
    const waitEnter = Date.now();
    while (!configEntered && Date.now() - waitEnter < 2_000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!configEntered) throw new Error("recoverFlagsmith did not fetch config.json");

    stop();
    const starting = start();
    release();
    await Promise.all([recovering, starting]);

    const runtime = getRuntime() as TestRuntime;
    expect(runtime.started).toBe(true);
    expect(runtime.timer).not.toBe(0);
    expect(sdkLoads).toBe(1);
    runtime.biometric = 90;
    await new Promise((r) => setTimeout(r, 400));
    expect(runtime.lastScore).toBeGreaterThan(0.1);
  });
});
