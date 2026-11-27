const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

export function hostnameOf(raw: string): string {
  const url = new URL(raw);
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(h);
}

export function isLoopbackUrl(raw: string): boolean {
  try {
    return isLoopbackHost(hostnameOf(raw));
  } catch {
    return false;
  }
}

export function assertAllowedUrl(raw: string, allowRemote: boolean, label: string): void {
  let host = "";
  try {
    host = hostnameOf(raw);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (allowRemote) return;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `${label} host is not loopback. Pass --allow-remote only for a controlled environment.`,
    );
  }
}
