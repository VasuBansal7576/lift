import { readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const AUTH = /(Authorization:\s*(?:Api-Key|Token)\s+)\S+/gi;
const BEARER = /(Bearer\s+)\S+/gi;
const ENV_ASSIGN =
  /((?:FLAGSMITH_(?:ADMIN_API_TOKEN|SERVER_KEY|API_KEY(?:_[A-Za-z0-9]+)?)|PASSWORD|password|secret)\s*[=:]\s*)\S+/gi;
const JSON_SECRET =
  /("(?:api_key|key|password|token|secret|adminToken|serverKey)"\s*:\s*")[^"]*/gi;

const SERVER_KEY = /\bser\.[A-Za-z0-9_-]+/g;

/** Strip credentials from logs, JSON, and CLI output. Never print keys. */
export function redactSecrets(text: string): string {
  return text
    .replace(AUTH, "$1[REDACTED]")
    .replace(BEARER, "$1[REDACTED]")
    .replace(ENV_ASSIGN, "$1[REDACTED]")
    .replace(JSON_SECRET, "$1[REDACTED]")
    .replace(SERVER_KEY, "ser.[REDACTED]");
}

const SERVER_KEY_VISIBLE = /\bser\.[A-Za-z0-9]/;

/** Abort if a Flagsmith server-style key is about to appear on screen or in a log. */
export function assertNoServerKeyVisible(text: string): void {
  if (SERVER_KEY_VISIBLE.test(text)) {
    throw new Error("server-style ser. key visible");
  }
}

/** Paths under dir whose contents are scanned during a live capture. */
export function liftScanFiles(dir = "/tmp"): string[] {
  try {
    return readdirSync(dir)
      .filter(
        (name) =>
          name.startsWith("lift-") &&
          (name.endsWith(".log") || name === "lift-proof-bootstrap.json"),
      )
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Catch only read errors; a matching line must still throw. */
export function abortIfServerKeyInFiles(paths: string[]): void {
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    assertNoServerKeyVisible(text);
  }
}

export function maskKey(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return `…${value.slice(-4)}`;
}

export function printJson(value: unknown): void {
  writeSync(1, `${redactSecrets(JSON.stringify(value))}\n`);
}
