import { describe, expect, it } from "vitest";
import {
  cookieWriteValue,
  IDENTITY_COOKIE,
  IDENTITY_MAX_AGE_SEC,
  isUsableIdentity,
  readCookieIdentity,
  readQueryIdentity,
  resolveVisitorId,
  type IdentityEnv,
} from "../../sites/shared/identity.js";

function makeEnv(init: {
  search?: string;
  cookie?: string;
  storage?: string | null;
  randomId?: string;
  secure?: boolean;
}): IdentityEnv & { cookieHeader: string; storageValue: string | null; cookieWrites: string[] } {
  let cookieHeader = init.cookie ?? "";
  let storageValue = init.storage ?? null;
  const cookieWrites: string[] = [];
  return {
    search: init.search ?? "",
    getCookie: () => cookieHeader,
    setCookie: (value) => {
      cookieWrites.push(value);
      cookieHeader = value;
    },
    getStorage: () => storageValue,
    setStorage: (value) => {
      storageValue = value;
    },
    randomId: () => init.randomId ?? "fresh-uuid-0000",
    secure: init.secure ?? false,
    get cookieHeader() {
      return cookieHeader;
    },
    get storageValue() {
      return storageValue;
    },
    cookieWrites,
  };
}

describe("isUsableIdentity", () => {
  it("accepts UUIDs and bot identities", () => {
    expect(isUsableIdentity("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
    expect(isUsableIdentity("lift-sim-20261127010101-20261126-0")).toBe(true);
  });

  it("rejects empty, oversized, and cookie-breaking values", () => {
    expect(isUsableIdentity("")).toBe(false);
    expect(isUsableIdentity(" spaced")).toBe(false);
    expect(isUsableIdentity("a".repeat(200))).toBe(false);
    expect(isUsableIdentity("bad;drop")).toBe(false);
    expect(isUsableIdentity("bad,comma")).toBe(false);
  });
});

describe("readQueryIdentity", () => {
  it("reads ?lift_identity= for bots", () => {
    expect(readQueryIdentity("?lift_identity=lift-sim-run-1-0")).toBe("lift-sim-run-1-0");
    expect(readQueryIdentity("lift_identity=plain")).toBe("plain");
  });

  it("ignores missing or unusable query values", () => {
    expect(readQueryIdentity("")).toBeNull();
    expect(readQueryIdentity("?other=1")).toBeNull();
    expect(readQueryIdentity("?lift_identity=bad;id")).toBeNull();
  });
});

describe("cookie stickiness", () => {
  it("writes a first-party Lax cookie without Secure on http", () => {
    const value = cookieWriteValue("visitor-1", false);
    expect(value).toContain(`${IDENTITY_COOKIE}=visitor-1`);
    expect(value).toContain("Path=/");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain(`Max-Age=${IDENTITY_MAX_AGE_SEC}`);
    expect(value).not.toContain("Secure");
  });

  it("adds Secure only on https", () => {
    expect(cookieWriteValue("visitor-1", true)).toContain("Secure");
  });

  it("reads the identity out of a cookie header", () => {
    expect(readCookieIdentity("other=1; lift_vid=abc123; theme=dark")).toBe("abc123");
    expect(readCookieIdentity("")).toBeNull();
    expect(readCookieIdentity("lift_vid=bad,comma")).toBeNull();
  });

  it("prefers ?lift_identity= over cookie and storage, then persists it", () => {
    const env = makeEnv({
      search: "?lift_identity=lift-sim-bot-9",
      cookie: "lift_vid=old-cookie",
      storage: "old-storage",
    });
    expect(resolveVisitorId(env)).toBe("lift-sim-bot-9");
    expect(env.storageValue).toBe("lift-sim-bot-9");
    expect(env.cookieWrites[0]).toContain("lift_vid=lift-sim-bot-9");
  });

  it("reuses the cookie when the query is absent", () => {
    const env = makeEnv({ cookie: "lift_vid=sticky-cookie", storage: "other-storage" });
    expect(resolveVisitorId(env)).toBe("sticky-cookie");
    expect(env.storageValue).toBe("sticky-cookie");
  });

  it("falls back to localStorage when the cookie is missing", () => {
    const env = makeEnv({ storage: "from-ls" });
    expect(resolveVisitorId(env)).toBe("from-ls");
    expect(env.cookieWrites[0]).toContain("lift_vid=from-ls");
  });

  it("mints a new id only when cookie and storage are empty, then persists both", () => {
    const env = makeEnv({ randomId: "minted-once" });
    expect(resolveVisitorId(env)).toBe("minted-once");
    expect(resolveVisitorId(env)).toBe("minted-once");
    expect(env.storageValue).toBe("minted-once");
    expect(env.cookieWrites.length).toBeGreaterThan(0);
  });

  it("skips a poisoned cookie and uses storage instead", () => {
    const env = makeEnv({ cookie: "lift_vid=bad,comma", storage: "safe-store" });
    expect(resolveVisitorId(env)).toBe("safe-store");
  });
});
