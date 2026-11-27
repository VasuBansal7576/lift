/** First-party visitor id. Bot override requires lift_bot=1 and is not persisted. */

export const IDENTITY_COOKIE = "lift_vid";
export const IDENTITY_STORAGE_KEY = "lift_vid";
export const IDENTITY_MAX_AGE_SEC = 60 * 60 * 24 * 365;
export const IDENTITY_MAX_LENGTH = 128;

/**
 * @typedef {object} IdentityEnv
 * @property {string} search
 * @property {() => string} getCookie
 * @property {(value: string) => void} setCookie
 * @property {() => string | null} getStorage
 * @property {(value: string) => void} setStorage
 * @property {() => string} randomId
 * @property {boolean} secure
 * @property {string} [host]
 * @property {boolean} [allowBotOverride]
 */

export function isUsableIdentity(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > IDENTITY_MAX_LENGTH) return false;
  if (trimmed !== value) return false;
  if (/[\u0000-\u001F\u007F;,]/.test(trimmed)) return false;
  return true;
}

export function isLoopbackHost(host) {
  if (typeof host !== "string" || host.length === 0) return false;
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0:0:0:0:0:0:0:1";
}

/** Query override is for local traffic bots only, never for deployed pages. */
export function botOverrideAllowed(env) {
  if (env && env.allowBotOverride === true) return true;
  if (typeof globalThis !== "undefined" && globalThis.LIFT_ALLOW_BOT_OVERRIDE === true) {
    return true;
  }
  return isLoopbackHost(env && env.host);
}

export function readQueryIdentity(search, env) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("lift_bot") !== "1") return null;
  if (!botOverrideAllowed(env ?? {})) return null;
  const raw = params.get("lift_identity");
  if (raw === null) return null;
  return isUsableIdentity(raw) ? raw : null;
}

export function readCookieIdentity(header) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== IDENTITY_COOKIE) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      const decoded = decodeURIComponent(raw);
      return isUsableIdentity(decoded) ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function cookieWriteValue(id, secure) {
  // Path=/ is host-wide. On a GitHub Pages host (*.github.io) that is one cookie
  // for every project site on the same user/org domain — fine for the demo.
  const base = `${IDENTITY_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=${IDENTITY_MAX_AGE_SEC}; SameSite=Lax`;
  return secure ? `${base}; Secure` : base;
}

function persist(id, env) {
  try {
    env.setCookie(cookieWriteValue(id, env.secure));
  } catch {
    /* fail-open: cookie may be blocked */
  }
  try {
    env.setStorage(id);
  } catch {
    /* fail-open: storage may be blocked */
  }
}

/** Resolve a sticky visitor id. Cookie, then localStorage, then a new UUID. */
export function resolveVisitorId(env) {
  const fromQuery = readQueryIdentity(env.search, env);
  if (fromQuery) {
    // Honor ?lift_identity= only when lift_bot=1 is present AND the page is on
    // loopback (or a build-time LIFT_ALLOW_BOT_OVERRIDE flag). Do not persist
    // that override: a crafted link must not overwrite a real visitor cookie,
    // and deployed pages (e.g. *.github.io) ignore the query entirely.
    return fromQuery;
  }
  const fromCookie = readCookieIdentity(env.getCookie());
  if (fromCookie) {
    persist(fromCookie, env);
    return fromCookie;
  }
  let fromStorage = null;
  try {
    fromStorage = env.getStorage();
  } catch {
    fromStorage = null;
  }
  if (fromStorage && isUsableIdentity(fromStorage)) {
    persist(fromStorage, env);
    return fromStorage;
  }
  const fresh = env.randomId();
  persist(fresh, env);
  return fresh;
}

export function browserIdentityEnv() {
  return {
    search: typeof location === "undefined" ? "" : location.search,
    getCookie: () => (typeof document === "undefined" ? "" : document.cookie),
    setCookie: (value) => {
      if (typeof document !== "undefined") document.cookie = value;
    },
    getStorage: () => {
      try {
        return localStorage.getItem(IDENTITY_STORAGE_KEY);
      } catch {
        return null;
      }
    },
    setStorage: (value) => {
      try {
        localStorage.setItem(IDENTITY_STORAGE_KEY, value);
      } catch {
        /* fail-open */
      }
    },
    randomId: () => crypto.randomUUID(),
    secure: typeof location !== "undefined" && location.protocol === "https:",
    host: typeof location !== "undefined" ? location.hostname : "",
  };
}
