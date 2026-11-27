import { L3_COOKIE } from "./l3-constants.ts";

export function parseCookie(header: string, name: string): string {
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

export function serializeCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

export function resolveStickyIdentity(input: {
  queryIdentity?: string | null;
  cookieHeader?: string;
  randomId?: string;
}): { identity: string; cookie: string; source: "query" | "cookie" | "new" } {
  const fromQuery = (input.queryIdentity ?? "").trim();
  if (fromQuery) {
    return {
      identity: fromQuery,
      cookie: serializeCookie(L3_COOKIE, fromQuery),
      source: "query",
    };
  }
  const fromCookie = parseCookie(input.cookieHeader ?? "", L3_COOKIE).trim();
  if (fromCookie) {
    return {
      identity: fromCookie,
      cookie: serializeCookie(L3_COOKIE, fromCookie),
      source: "cookie",
    };
  }
  const created = (input.randomId ?? "").trim() || `lift-${Date.now()}`;
  return {
    identity: created,
    cookie: serializeCookie(L3_COOKIE, created),
    source: "new",
  };
}
