/** Parse an incoming HTTP request URL. Never throws. */
export function parseIncomingUrl(reqUrl: string | undefined, origin: string): URL | null {
  try {
    const path = reqUrl == null || reqUrl === "" ? "/" : reqUrl;
    const url = new URL(path, origin);
    const base = new URL(origin);
    if (url.origin !== base.origin) return null;
    return url;
  } catch {
    return null;
  }
}
