/**
 * Lift Layer 3 — Cognitive Overload Balancer
 * Standalone browser module (no dependencies). Load with:
 *   <script type="module" src="/runtime/l3-balancer.js"></script>
 *
 * Privacy: only the boolean identity trait `overstimulated` ever leaves the page.
 * Raw mouse, click, scroll, and slider samples stay in memory and are dropped
 * after the 5s rolling window. There is no screenshot, recording, or keylog.
 *
 * Decision path: detectors → hysteresis → flagsmith.setTrait → Flagsmith
 * segment evaluation → hasFeature("l3_sensory_safe") → UI. The page does not
 * apply Sensory-Safe from a local score threshold check.
 *
 * Constants must stay in sync with shared/l3-constants.ts.
 */
const L3_FLAG_NAME = "l3_sensory_safe";
const L3_SEGMENT_NAME = "sensory_safe";
const L3_TRAIT_NAME = "overstimulated";
const L3_COOKIE = "lift_vid";
const L3_SDK_URL = "https://cdn.jsdelivr.net/npm/@flagsmith/flagsmith@12.4.0/+esm";

const WINDOW_MS = 5_000;
const ENTER_THRESHOLD = 0.62;
const EXIT_THRESHOLD = 0.38;
const ENTER_HOLD_MS = 1_500;
const EXIT_HOLD_MS = 8_000;
const COOLDOWN_MS = 10_000;
const FADE_MS = 2_000;
const RAGE_CLICK_COUNT = 3;
const RAGE_CLICK_MS = 700;
const RAGE_CLICK_RADIUS_PX = 30;
const WCAG_AA_MIN = 4.5;
const WEIGHTS = Object.freeze({
  erraticMouse: 0.3,
  rageClicks: 0.25,
  scrollThrash: 0.25,
  biometric: 0.2,
});
const SOFT_INK = [44, 48, 56];
const SOFT_PAPER = [244, 240, 232];
const DEFAULT_FLAG_CONFIG = Object.freeze({
  pauseMedia: true,
  pauseMotion: true,
  softenContrast: true,
  showSummaries: true,
  hideMarketing: true,
  fadeMs: FADE_MS,
  ink: "#2c3038",
  paper: "#f4f0e8",
});

export const L3_CONSTANTS = Object.freeze({
  L3_FLAG_NAME,
  L3_SEGMENT_NAME,
  L3_TRAIT_NAME,
  L3_COOKIE,
  L3_SDK_URL,
  WINDOW_MS,
  ENTER_THRESHOLD,
  EXIT_THRESHOLD,
  ENTER_HOLD_MS,
  EXIT_HOLD_MS,
  COOLDOWN_MS,
  FADE_MS,
  RAGE_CLICK_COUNT,
  RAGE_CLICK_MS,
  RAGE_CLICK_RADIUS_PX,
  WCAG_AA_MIN,
  WEIGHTS,
  SOFT_INK,
  SOFT_PAPER,
  DEFAULT_FLAG_CONFIG,
});

export function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function inWindow(samples, now, windowMs = WINDOW_MS) {
  const cut = now - windowMs;
  return samples.filter((s) => s.t >= cut && s.t <= now);
}

function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function mouseJitter(points) {
  if (points.length < 2) return 1;
  let path = 0;
  for (let i = 1; i < points.length; i += 1) path += dist(points[i - 1], points[i]);
  const displacement = dist(points[0], points[points.length - 1]);
  if (path < 40) return 1;
  return path / Math.max(displacement, 1);
}

export function directionChangeRate(points) {
  if (points.length < 3) return 0;
  let changes = 0;
  let counted = 0;
  for (let i = 2; i < points.length; i += 1) {
    const a = points[i - 2];
    const b = points[i - 1];
    const c = points[i];
    const v1x = b.x - a.x;
    const v1y = b.y - a.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const n1 = Math.hypot(v1x, v1y);
    const n2 = Math.hypot(v2x, v2y);
    if (n1 < 1 || n2 < 1) continue;
    counted += 1;
    const cos = Math.min(1, Math.max(-1, (v1x * v2x + v1y * v2y) / (n1 * n2)));
    if (Math.acos(cos) > Math.PI / 3) changes += 1;
  }
  return counted === 0 ? 0 : changes / counted;
}

export function scoreErraticMouse(points, now, windowMs = WINDOW_MS) {
  const recent = inWindow(points, now, windowMs);
  if (recent.length < 5) return 0;
  const jitterScore = clamp01((mouseJitter(recent) - 1.5) / 10);
  const turnScore = clamp01(directionChangeRate(recent) / 0.55);
  return clamp01(0.55 * jitterScore + 0.45 * turnScore);
}

export function detectRageClicks(clicks, now, windowMs = WINDOW_MS) {
  const recent = inWindow(clicks, now, windowMs);
  for (let i = 0; i < recent.length; i += 1) {
    const origin = recent[i];
    let n = 0;
    for (let j = 0; j < recent.length; j += 1) {
      const other = recent[j];
      if (Math.abs(other.t - origin.t) > RAGE_CLICK_MS) continue;
      if (dist(origin, other) > RAGE_CLICK_RADIUS_PX) continue;
      n += 1;
    }
    if (n >= RAGE_CLICK_COUNT) return 1;
  }
  return 0;
}

export function scoreScrollThrash(scrolls, now, windowMs = WINDOW_MS) {
  const recent = inWindow(scrolls, now, windowMs);
  if (recent.length < 3) return 0;
  let reversals = 0;
  let distPx = 0;
  for (let i = 1; i < recent.length; i += 1) {
    const dy = recent[i].dy !== 0 ? recent[i].dy : recent[i].y - recent[i - 1].y;
    distPx += Math.abs(dy);
    if (i >= 2) {
      const prevDy =
        recent[i - 1].dy !== 0 ? recent[i - 1].dy : recent[i - 1].y - recent[i - 2].y;
      if (Math.sign(dy) !== 0 && Math.sign(prevDy) !== 0 && Math.sign(dy) !== Math.sign(prevDy)) {
        reversals += 1;
      }
    }
  }
  const dt = (recent[recent.length - 1].t - recent[0].t) / 1000;
  if (dt <= 0) return 0;
  return clamp01(0.5 * clamp01(distPx / dt / 2500) + 0.5 * clamp01(reversals / dt / 4));
}

export function scoreBiometric(value0to100) {
  return clamp01(value0to100 / 100);
}

export function combineStress(parts) {
  return clamp01(
    WEIGHTS.erraticMouse * parts.erraticMouse +
      WEIGHTS.rageClicks * parts.rageClicks +
      WEIGHTS.scrollThrash * parts.scrollThrash +
      WEIGHTS.biometric * parts.biometric,
  );
}

export function scoreFromSamples(input) {
  const windowMs = input.windowMs ?? WINDOW_MS;
  const components = {
    erraticMouse: scoreErraticMouse(input.mouse, input.now, windowMs),
    rageClicks: detectRageClicks(input.clicks, input.now, windowMs),
    scrollThrash: scoreScrollThrash(input.scrolls, input.now, windowMs),
    biometric: scoreBiometric(input.biometric),
  };
  return { score: combineStress(components), components };
}

export function initialHysteresis() {
  return {
    overstimulated: false,
    enterStartedAt: null,
    exitStartedAt: null,
    lastChangeAt: null,
    cooldownUntil: 0,
  };
}

export function hysteresisPhase(state, now) {
  if (now < state.cooldownUntil) return "cooldown";
  if (state.overstimulated) return state.exitStartedAt != null ? "exit_pending" : "overstimulated";
  return state.enterStartedAt != null ? "enter_pending" : "calm";
}

export function stepHysteresis(state, score, now, cfg = {}) {
  const enterThreshold = cfg.enterThreshold ?? ENTER_THRESHOLD;
  const exitThreshold = cfg.exitThreshold ?? EXIT_THRESHOLD;
  const enterHoldMs = cfg.enterHoldMs ?? ENTER_HOLD_MS;
  const exitHoldMs = cfg.exitHoldMs ?? EXIT_HOLD_MS;
  const cooldownMs = cfg.cooldownMs ?? COOLDOWN_MS;
  if (exitThreshold >= enterThreshold) {
    throw new Error("EXIT_THRESHOLD must be strictly lower than ENTER_THRESHOLD");
  }
  const next = { ...state };
  if (now < next.cooldownUntil) {
    next.enterStartedAt = null;
    next.exitStartedAt = null;
    return { state: next, event: "none" };
  }
  if (!next.overstimulated) {
    next.exitStartedAt = null;
    if (score >= enterThreshold) {
      if (next.enterStartedAt == null) next.enterStartedAt = now;
      if (now - next.enterStartedAt >= enterHoldMs) {
        next.overstimulated = true;
        next.enterStartedAt = null;
        next.lastChangeAt = now;
        next.cooldownUntil = now + cooldownMs;
        return { state: next, event: "enter" };
      }
    } else {
      next.enterStartedAt = null;
    }
    return { state: next, event: "none" };
  }
  next.enterStartedAt = null;
  if (score < exitThreshold) {
    if (next.exitStartedAt == null) next.exitStartedAt = now;
    if (now - next.exitStartedAt >= exitHoldMs) {
      next.overstimulated = false;
      next.exitStartedAt = null;
      next.lastChangeAt = now;
      next.cooldownUntil = now + cooldownMs;
      return { state: next, event: "exit" };
    }
  } else {
    next.exitStartedAt = null;
  }
  return { state: next, event: "none" };
}

function relativeLuminance(r, g, b) {
  const lin = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(...fg);
  const l2 = relativeLuminance(...bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function clampChannel(n) {
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function rgbToHex(rgb) {
  return `#${rgb.map((c) => clampChannel(c).toString(16).padStart(2, "0")).join("")}`;
}

function parseHex(color) {
  const hex = color.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(hex);
  if (short) {
    const [r, g, b] = short[1].split("").map((c) => Number.parseInt(c + c, 16));
    return [r, g, b];
  }
  const long = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!long) throw new Error(`Unparsed CSS color: ${color}`);
  const n = long[1];
  return [
    Number.parseInt(n.slice(0, 2), 16),
    Number.parseInt(n.slice(2, 4), 16),
    Number.parseInt(n.slice(4, 6), 16),
  ];
}

function desaturate(rgb, amount) {
  const gray = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return [
    clampChannel(rgb[0] + (gray - rgb[0]) * amount),
    clampChannel(rgb[1] + (gray - rgb[1]) * amount),
    clampChannel(rgb[2] + (gray - rgb[2]) * amount),
  ];
}

function mix(a, b, t) {
  return [
    clampChannel(a[0] + (b[0] - a[0]) * t),
    clampChannel(a[1] + (b[1] - a[1]) * t),
    clampChannel(a[2] + (b[2] - a[2]) * t),
  ];
}

function darken(rgb, amount) {
  return rgb.map((c) => clampChannel(c * (1 - amount)));
}

function lighten(rgb, amount) {
  return rgb.map((c) => clampChannel(c + (255 - c) * amount));
}

export function assertContrastFloor(fg, bg, min = WCAG_AA_MIN) {
  const ratio = contrastRatio(fg, bg);
  if (ratio < min) {
    throw new Error(
      `Contrast ${ratio.toFixed(3)}:1 is below WCAG AA ${min}:1 for ${rgbToHex(fg)} on ${rgbToHex(bg)}`,
    );
  }
  return ratio;
}

export function softenPair(fg, bg) {
  let nextFg = desaturate(fg, 0.28);
  let nextBg = desaturate(bg, 0.22);
  const fgLum = relativeLuminance(...fg);
  const bgLum = relativeLuminance(...bg);
  if (fgLum < 0.2 && bgLum > 0.8) {
    nextFg = mix(nextFg, SOFT_INK, 0.85);
    nextBg = mix(nextBg, SOFT_PAPER, 0.85);
  } else if (bgLum < 0.2 && fgLum > 0.8) {
    nextBg = mix(nextBg, SOFT_INK, 0.85);
    nextFg = mix(nextFg, SOFT_PAPER, 0.85);
  }
  let guard = 0;
  while (contrastRatio(nextFg, nextBg) < WCAG_AA_MIN && guard < 80) {
    if (relativeLuminance(...nextFg) <= relativeLuminance(...nextBg)) {
      nextFg = darken(nextFg, 0.06);
      nextBg = lighten(nextBg, 0.04);
    } else {
      nextBg = darken(nextBg, 0.06);
      nextFg = lighten(nextFg, 0.04);
    }
    guard += 1;
  }
  return { fg: nextFg, bg: nextBg, contrast: assertContrastFloor(nextFg, nextBg) };
}

export function softenCssPair(fg, bg) {
  const pair = softenPair(parseHex(fg), parseHex(bg));
  return { fg: rgbToHex(pair.fg), bg: rgbToHex(pair.bg), contrast: pair.contrast };
}

export function parseCookie(header, name) {
  if (!header) return "";
  const parts = header.split(";");
  for (const part of parts) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return "";
}

export function stickyIdentity(doc = typeof document !== "undefined" ? document : null) {
  if (!doc) return "lift-node";
  const params = new URLSearchParams(doc.defaultView?.location?.search ?? "");
  const fromQuery = (params.get("lift_identity") || "").trim();
  if (fromQuery) {
    doc.cookie = `${L3_COOKIE}=${encodeURIComponent(fromQuery)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    return fromQuery;
  }
  const existing = parseCookie(doc.cookie, L3_COOKIE).trim();
  if (existing) return existing;
  const created = `lift-${crypto.randomUUID()}`;
  doc.cookie = `${L3_COOKIE}=${encodeURIComponent(created)}; Path=/; Max-Age=31536000; SameSite=Lax`;
  return created;
}

function params() {
  return new URLSearchParams(typeof location !== "undefined" ? location.search : "");
}

function isHudOff() {
  return params().get("hud") === "0";
}

function isOfflineFallback() {
  return params().get("l3_offline") === "1";
}

function timingConfig() {
  if (params().get("l3_fast") !== "1") {
    return {
      enterThreshold: ENTER_THRESHOLD,
      exitThreshold: EXIT_THRESHOLD,
      enterHoldMs: ENTER_HOLD_MS,
      exitHoldMs: EXIT_HOLD_MS,
      cooldownMs: COOLDOWN_MS,
      fadeMs: FADE_MS,
    };
  }
  return {
    enterThreshold: ENTER_THRESHOLD,
    exitThreshold: EXIT_THRESHOLD,
    enterHoldMs: 400,
    exitHoldMs: 800,
    cooldownMs: 500,
    fadeMs: 400,
  };
}

const runtime = {
  mouse: [],
  clicks: [],
  scrolls: [],
  biometric: 20,
  hysteresis: initialHysteresis(),
  flagsmith: null,
  identity: "",
  trait: false,
  flagOn: false,
  flagConfig: { ...DEFAULT_FLAG_CONFIG },
  segmentMember: false,
  offline: false,
  forceScore: null,
  lastScore: 0,
  lastComponents: {
    erraticMouse: 0,
    rageClicks: 0,
    scrollThrash: 0,
    biometric: 0.2,
  },
  lastPhase: "calm",
  applying: false,
  timer: 0,
  cursorEl: null,
  started: false,
};

function trimSamples(now) {
  const cut = now - WINDOW_MS * 2;
  runtime.mouse = runtime.mouse.filter((s) => s.t >= cut);
  runtime.clicks = runtime.clicks.filter((s) => s.t >= cut);
  runtime.scrolls = runtime.scrolls.filter((s) => s.t >= cut);
}

function parseFlagConfig(raw) {
  const base = { ...DEFAULT_FLAG_CONFIG };
  if (raw == null || raw === "") return base;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== "object") return base;
    return { ...base, ...parsed };
  } catch {
    return base;
  }
}

function traitIsTrue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function pauseMedia() {
  document.querySelectorAll("video, audio").forEach((el) => {
    if (!("paused" in el)) return;
    el.dataset.liftWasPlaying = el.paused ? "0" : "1";
    el.pause();
    el.autoplay = false;
  });
}

function resumeMedia() {
  document.querySelectorAll("video, audio").forEach((el) => {
    if (el.dataset.liftWasPlaying === "1") {
      const play = el.play();
      if (play && typeof play.catch === "function") play.catch(() => {});
    }
    delete el.dataset.liftWasPlaying;
  });
}

function revealSummaries(on) {
  document.querySelectorAll("[data-lift-summary]").forEach((el) => {
    if (on) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "");
  });
}

function setBannerHidden(on) {
  document
    .querySelectorAll("[data-lift-promo], [data-lift-cookie], [data-lift-marketing]")
    .forEach((el) => {
      el.hidden = on;
    });
}

function applySoftColors(on, config) {
  const root = document.documentElement;
  if (on && config.softenContrast) {
    const pair = softenCssPair("#000000", "#ffffff");
    root.style.setProperty("--lift-ink", config.ink || pair.fg);
    root.style.setProperty("--lift-paper", config.paper || pair.bg);
    root.dataset.liftContrast = String(pair.contrast.toFixed(2));
  } else {
    root.style.removeProperty("--lift-ink");
    root.style.removeProperty("--lift-paper");
    delete root.dataset.liftContrast;
  }
}

/**
 * Apply or reverse Sensory-Safe from a Flagsmith flag decision.
 * Never changes roles, names, or tabindex. Never hides [data-lift-essential] or #checkout.
 */
export function applySensorySafe(on, config = DEFAULT_FLAG_CONFIG) {
  const root = document.documentElement;
  const fadeMs = Number(config.fadeMs) || FADE_MS;
  root.style.setProperty("--lift-fade-ms", `${fadeMs}ms`);
  if (on) {
    root.classList.add("lift-sensory-safe");
    root.classList.remove("lift-sensory-restoring");
    root.dataset.liftSensory = "on";
    if (config.pauseMedia !== false) pauseMedia();
    if (config.showSummaries !== false) revealSummaries(true);
    if (config.hideMarketing !== false) setBannerHidden(true);
    applySoftColors(true, config);
  } else {
    const wasOn = root.classList.contains("lift-sensory-safe");
    root.classList.remove("lift-sensory-safe");
    if (wasOn) root.classList.add("lift-sensory-restoring");
    root.dataset.liftSensory = "off";
    resumeMedia();
    revealSummaries(false);
    setBannerHidden(false);
    applySoftColors(false, config);
    window.setTimeout(() => {
      root.classList.remove("lift-sensory-restoring");
    }, fadeMs);
  }
  document.dispatchEvent(
    new CustomEvent("lift:sensory-safe", { detail: { on, config, source: "flagsmith-flag" } }),
  );
}

function readFlagsmithState(flagsmith) {
  const traitRaw =
    typeof flagsmith.getTrait === "function" ? flagsmith.getTrait(L3_TRAIT_NAME) : undefined;
  const flagOn =
    typeof flagsmith.hasFeature === "function" ? Boolean(flagsmith.hasFeature(L3_FLAG_NAME)) : false;
  const value = typeof flagsmith.getValue === "function" ? flagsmith.getValue(L3_FLAG_NAME) : null;
  const trait = traitIsTrue(traitRaw);
  return {
    trait,
    flagOn,
    flagConfig: parseFlagConfig(value),
    segmentMember: trait && flagOn,
  };
}

async function applyFromFlagsmith() {
  if (runtime.offline) {
    const on = runtime.trait;
    runtime.flagOn = on;
    runtime.segmentMember = on;
    runtime.flagConfig = { ...DEFAULT_FLAG_CONFIG };
    applySensorySafe(on, runtime.flagConfig);
    renderHud();
    return;
  }
  const flagsmith = runtime.flagsmith;
  if (!flagsmith) return;
  const snapshot = readFlagsmithState(flagsmith);
  runtime.trait = snapshot.trait;
  runtime.flagOn = snapshot.flagOn;
  runtime.flagConfig = snapshot.flagConfig;
  runtime.segmentMember = snapshot.segmentMember;
  applySensorySafe(snapshot.flagOn, snapshot.flagConfig);
  renderHud();
}

async function pushTrait(value) {
  runtime.trait = value;
  if (runtime.offline) {
    await applyFromFlagsmith();
    return;
  }
  const flagsmith = runtime.flagsmith;
  if (!flagsmith || typeof flagsmith.setTrait !== "function") return;
  await flagsmith.setTrait(L3_TRAIT_NAME, value);
  if (typeof flagsmith.getFlags === "function") {
    try {
      await flagsmith.getFlags();
    } catch {
      /* still apply whatever the SDK currently has */
    }
  }
  await applyFromFlagsmith();
}

function fmt(n) {
  return Number(n).toFixed(2);
}

function renderHud() {
  const hud = document.getElementById("lift-l3-hud");
  if (!hud) return;
  if (isHudOff()) {
    hud.hidden = true;
    return;
  }
  hud.hidden = false;
  const now = Date.now();
  const cooldownLeft = Math.max(0, runtime.hysteresis.cooldownUntil - now);
  const offlineNote = runtime.offline
    ? `<p class="l3-hud-warn">OFFLINE FALLBACK — tests only. Flagsmith segment evaluation skipped.</p>`
    : "";
  hud.dataset.score = fmt(runtime.lastScore);
  hud.dataset.trait = String(runtime.trait);
  hud.dataset.flag = String(runtime.flagOn);
  hud.dataset.segment = String(runtime.segmentMember);
  hud.dataset.phase = runtime.lastPhase;
  hud.dataset.offline = String(runtime.offline);
  hud.innerHTML = `
    <p class="l3-hud-title">L3 Cognitive Overload Balancer</p>
    ${offlineNote}
    <p>score <strong data-l3="score">${fmt(runtime.lastScore)}</strong>${runtime.forceScore == null ? "" : " (forced)"}</p>
    <ul>
      <li>mouse ${fmt(runtime.lastComponents.erraticMouse)}</li>
      <li>rage ${fmt(runtime.lastComponents.rageClicks)}</li>
      <li>scroll ${fmt(runtime.lastComponents.scrollThrash)}</li>
      <li>biometric ${fmt(runtime.lastComponents.biometric)} <em>(simulated)</em></li>
    </ul>
    <p>trait overstimulated <strong data-l3="trait">${runtime.trait}</strong> <span>(Flagsmith)</span></p>
    <p>segment ${L3_SEGMENT_NAME} <strong data-l3="segment">${runtime.segmentMember ? "member" : "not a member"}</strong></p>
    <p>flag ${L3_FLAG_NAME} <strong data-l3="flag">${runtime.flagOn ? "on" : "off"}</strong></p>
    <p>phase <strong data-l3="phase">${runtime.lastPhase}</strong> cooldown ${Math.ceil(cooldownLeft / 1000)}s</p>
    <p class="l3-hud-id">identity ${runtime.identity}</p>
  `;
}

function ensureCursorDot() {
  if (runtime.cursorEl || isHudOff()) return;
  const el = document.createElement("div");
  el.id = "lift-l3-cursor";
  el.setAttribute("aria-hidden", "true");
  document.body.appendChild(el);
  runtime.cursorEl = el;
}

function tick() {
  const now = Date.now();
  trimSamples(now);
  const computed = scoreFromSamples({
    mouse: runtime.mouse,
    clicks: runtime.clicks,
    scrolls: runtime.scrolls,
    biometric: runtime.biometric,
    now,
  });
  runtime.lastComponents = computed.components;
  runtime.lastScore = runtime.forceScore == null ? computed.score : clamp01(runtime.forceScore);
  const stepped = stepHysteresis(runtime.hysteresis, runtime.lastScore, now, timingConfig());
  runtime.hysteresis = stepped.state;
  runtime.lastPhase = hysteresisPhase(runtime.hysteresis, now);
  if (stepped.event === "enter" && !runtime.applying) {
    runtime.applying = true;
    void pushTrait(true).finally(() => {
      runtime.applying = false;
    });
  } else if (stepped.event === "exit" && !runtime.applying) {
    runtime.applying = true;
    void pushTrait(false).finally(() => {
      runtime.applying = false;
    });
  }
  renderHud();
}

function onMove(event) {
  runtime.mouse.push({ t: Date.now(), x: event.clientX, y: event.clientY });
  if (runtime.cursorEl) {
    runtime.cursorEl.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
  }
}

function onClick(event) {
  runtime.clicks.push({ t: Date.now(), x: event.clientX, y: event.clientY });
}

function onWheel(event) {
  runtime.scrolls.push({
    t: Date.now(),
    y: window.scrollY || 0,
    dy: event.deltaY || 0,
  });
}

function onScroll() {
  const y = window.scrollY || 0;
  const last = runtime.scrolls[runtime.scrolls.length - 1];
  runtime.scrolls.push({ t: Date.now(), y, dy: last ? y - last.y : 0 });
}

function bindBiometric() {
  const slider = document.getElementById("lift-biometric");
  if (!slider) return;
  const read = () => {
    runtime.biometric = Number(slider.value) || 0;
  };
  read();
  slider.addEventListener("input", read);
}

async function loadConfig() {
  try {
    const res = await fetch("./config.json", { cache: "no-store" });
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

async function initFlagsmith(config) {
  if (isOfflineFallback()) {
    runtime.offline = true;
    runtime.identity = stickyIdentity();
    return;
  }
  runtime.identity = stickyIdentity();
  if (!config?.flagsmithEnvironmentKey) {
    runtime.offline = true;
    return;
  }
  const { default: flagsmith } = await import(L3_SDK_URL);
  await flagsmith.init({
    environmentID: config.flagsmithEnvironmentKey,
    api: config.flagsmithApiUrl,
    identity: runtime.identity,
    traits: {
      simulated: false,
      site: config.site || "l3",
      [L3_TRAIT_NAME]: false,
    },
  });
  runtime.flagsmith = flagsmith;
  runtime.offline = false;
  await applyFromFlagsmith();
}

export async function start() {
  if (runtime.started) return runtime;
  runtime.started = true;
  runtime.hysteresis = initialHysteresis();
  const config = await loadConfig();
  ensureCursorDot();
  bindBiometric();
  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("click", onClick, { passive: true });
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  try {
    await initFlagsmith(config);
  } catch (err) {
    runtime.offline = true;
    const hud = document.getElementById("lift-l3-hud");
    if (hud) {
      hud.dataset.error = err instanceof Error ? err.message : String(err);
    }
  }
  if (runtime.offline) {
    const banner = document.getElementById("lift-l3-offline");
    if (banner) banner.hidden = false;
  }
  runtime.timer = window.setInterval(tick, 120);
  tick();
  return runtime;
}

export function stop() {
  window.clearInterval(runtime.timer);
  runtime.started = false;
}

export function getRuntime() {
  return runtime;
}

export const LiftL3 = {
  L3_CONSTANTS,
  clamp01,
  inWindow,
  mouseJitter,
  directionChangeRate,
  scoreErraticMouse,
  detectRageClicks,
  scoreScrollThrash,
  scoreBiometric,
  combineStress,
  scoreFromSamples,
  initialHysteresis,
  hysteresisPhase,
  stepHysteresis,
  contrastRatio,
  rgbToHex,
  assertContrastFloor,
  softenPair,
  softenCssPair,
  parseCookie,
  stickyIdentity,
  applySensorySafe,
  start,
  stop,
  getRuntime,
  forceScore(n) {
    runtime.forceScore = n == null ? null : clamp01(Number(n));
  },
  ingest(kind, sample) {
    if (kind === "mouse") runtime.mouse.push(sample);
    else if (kind === "click") runtime.clicks.push(sample);
    else if (kind === "scroll") runtime.scrolls.push(sample);
    else if (kind === "biometric") runtime.biometric = Number(sample) || 0;
  },
};

if (typeof window !== "undefined") {
  window.LiftL3 = LiftL3;
  if (!window.__LIFT_L3_NO_AUTO__) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => void start(), { once: true });
    } else {
      void start();
    }
  }
}

export default LiftL3;
