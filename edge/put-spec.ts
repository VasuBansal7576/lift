import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePatchSpec, type PatchSpec } from "../shared/patch-spec.ts";

const SPEC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSpecKey(value: string): boolean {
  return SPEC_ID_RE.test(value);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type ValidateSpecResult =
  | { ok: true; spec: PatchSpec; path: string }
  | { ok: false; error: string };

export function validateSpecRaw(raw: unknown): ReturnType<typeof parsePatchSpec> {
  return parsePatchSpec(raw);
}

export function validateSpecFile(filePath: string): ValidateSpecResult {
  const abs = resolve(filePath);
  if (!existsSync(abs)) return { ok: false, error: `file not found: ${abs}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = parsePatchSpec(raw);
  if (!parsed.ok) return parsed;
  if (!isSpecKey(parsed.spec.id)) {
    return { ok: false, error: `spec id is not a safe KV key: ${parsed.spec.id}` };
  }
  return { ok: true, spec: parsed.spec, path: abs };
}

export function wranglerPutArgs(id: string, filePath: string): string[] {
  return [
    "wrangler",
    "kv",
    "key",
    "put",
    id,
    "--path",
    filePath,
    "--binding",
    "SPECS",
    "--local",
    "--config",
    resolve(root, "edge/wrangler.toml"),
    "--persist-to",
    resolve(root, "edge/.wrangler/state"),
    "--preview",
    "false",
  ];
}

export function putSpecToLocalKv(id: string, filePath: string) {
  const args = wranglerPutArgs(id, filePath);
  return spawnSync("npx", args, { cwd: root, encoding: "utf8" });
}

function usage(): never {
  process.stderr.write(
    "usage: npm run edge:put-spec -- <spec.json> [--validate-only]\n",
  );
  process.exit(2);
}

export function main(argv = process.argv.slice(2)): number {
  const validateOnly = argv.includes("--validate-only");
  const files = argv.filter((a) => a !== "--validate-only");
  if (files.length !== 1) usage();
  const result = validateSpecFile(files[0]);
  if (!result.ok) {
    process.stderr.write(`invalid spec: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(`valid spec id=${result.spec.id} ops=${result.spec.ops.length}\n`);
  if (validateOnly) return 0;
  const put = putSpecToLocalKv(result.spec.id, result.path);
  if (put.stdout) process.stdout.write(put.stdout);
  if (put.stderr) process.stderr.write(put.stderr);
  if (put.status !== 0) {
    process.stderr.write("wrangler kv put failed\n");
    return put.status ?? 1;
  }
  return 0;
}

const invoked = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (
  !/vitest|playwright/i.test(entry) &&
  (entry === invoked || /put-spec\.(ts|js)$/.test(entry))
) {
  process.exit(main());
}
