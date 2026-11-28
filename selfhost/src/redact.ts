import { readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const AUTH = /(Authorization:\s*(?:Api-Key|Token)\s+)\S+/gi;
const BEARER = /(Bearer\s+)\S+/gi;
const ENV_ASSIGN =
  /((?:FLAGSMITH_(?:ADMIN_API_TOKEN|SERVER_KEY|API_KEY(?:_[A-Za-z0-9]+)?)|PASSWORD|password|secret)\s*[=:]\s*)\S+/gi;
const JSON_SECRET =
  /("(?:api_key|key|password|token|secret|adminToken|serverKey|environmentKey)"\s*:\s*")[^"]*/gi;

const SERVER_KEY = /\bser\.[A-Za-z0-9_-]+/g;

const CONFIGURED_SECRET_ENV = [
  "FLAGSMITH_ENVIRONMENT_KEY",
  "FLAGSMITH_SERVER_KEY",
  "FLAGSMITH_ADMIN_API_TOKEN",
] as const;

function configuredSecretValues(): string[] {
  const values: string[] = [];
  for (const name of CONFIGURED_SECRET_ENV) {
    const value = process.env[name];
    if (value && value.length >= 4) values.push(value);
  }
  return values;
}

function secretValuesFrom(value: unknown, into: string[] = []): string[] {
  if (!value || typeof value !== "object") return into;
  if (Array.isArray(value)) {
    for (const item of value) secretValuesFrom(item, into);
    return into;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof nested === "string" &&
      nested.length >= 4 &&
      /environmentKey|serverKey|adminToken/i.test(key)
    ) {
      into.push(nested);
    }
    secretValuesFrom(nested, into);
  }
  return into;
}

/** Strip credentials from logs, JSON, and CLI output. Never print keys. */
export function redactSecrets(text: string, extra: readonly string[] = []): string {
  let out = text
    .replace(AUTH, "$1[REDACTED]")
    .replace(BEARER, "$1[REDACTED]")
    .replace(ENV_ASSIGN, "$1[REDACTED]")
    .replace(JSON_SECRET, "$1[REDACTED]")
    .replace(SERVER_KEY, "ser.[REDACTED]");
  for (const value of [...configuredSecretValues(), ...extra]) {
    if (value.length >= 4) out = out.split(value).join("[REDACTED]");
  }
  return out;
}

const SERVER_KEY_VISIBLE = /\bser\.[A-Za-z0-9]/;

/** Abort if a Flagsmith server-style key is about to appear on screen or in a log. */
export function assertNoServerKeyVisible(text: string): void {
  if (SERVER_KEY_VISIBLE.test(text)) {
    throw new Error("server-style ser. key visible");
  }
}

type SecretScanRoot = {
  body?: { innerText?: string; textContent?: string | null } | null;
  documentElement?: { textContent?: string | null } | null;
  textContent?: string | null;
  querySelectorAll: (sel: string) => ArrayLike<SecretScanNode>;
};

type SecretScanNode = {
  tagName: string;
  value?: string;
  attributes: ArrayLike<{ value: string }>;
  shadowRoot?: SecretScanRoot | null;
  contentDocument?: SecretScanRoot | null;
};

/** Walk visible text, form values, attributes, open shadow roots, and same-origin iframes. */
export function collectDomSecretScanText(doc: SecretScanRoot): string {
  const parts: string[] = [];
  const walk = (root: SecretScanRoot): void => {
    parts.push(root.body?.innerText ?? "", root.documentElement?.textContent ?? root.textContent ?? "");
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const tag = node.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        parts.push(node.value ?? "");
      }
      for (const attr of Array.from(node.attributes)) parts.push(attr.value);
      if (node.shadowRoot) {
        parts.push(node.shadowRoot.textContent ?? "");
        walk(node.shadowRoot);
      }
    }
    for (const iframe of Array.from(root.querySelectorAll("iframe"))) {
      try {
        const nested = iframe.contentDocument;
        if (nested) walk(nested);
      } catch {
        /* cross-origin */
      }
    }
  };
  walk(doc);
  return parts.join("\n");
}

/** Zero-arg page.evaluate entry; uses the document in the page context. */
export function scanPageSecrets(): string {
  return collectDomSecretScanText(globalThis.document as unknown as SecretScanRoot);
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
  writeSync(1, `${redactSecrets(JSON.stringify(value), secretValuesFrom(value))}\n`);
}
