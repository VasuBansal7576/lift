import {
  IDENTITY_COOKIE,
  cookieWriteValue,
  isUsableIdentity,
  readCookieIdentity,
} from "../../sites/shared/identity.js";

export { IDENTITY_COOKIE, cookieWriteValue, isUsableIdentity, readCookieIdentity };

/**
 * Resolve the sticky visitor id. Mint a `lift_vid` cookie when missing.
 * Not HttpOnly: the page must read lift_vid. Secure only on https.
 */
export function visitorFromRequest(request, url) {
  const header = request.headers.get("Cookie") || request.headers.get("cookie") || "";
  const existing = readCookieIdentity(header);
  if (existing) return { id: existing, setCookie: null, minted: false };
  const id = crypto.randomUUID();
  if (!isUsableIdentity(id)) {
    return { id: "lift-vid-fallback", setCookie: cookieWriteValue("lift-vid-fallback", url.protocol === "https:"), minted: true };
  }
  return {
    id,
    setCookie: cookieWriteValue(id, url.protocol === "https:"),
    minted: true,
  };
}
