import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { printJson } from "../selfhost/src/redact.ts";

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/flagsmith-a11y-experiment");

function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, acc);
    else acc.push(path);
  }
  return acc;
}

const files = walk(skillRoot).filter((p) => !p.endsWith(".webm") && !p.endsWith(".mp4"));
const rows = files.map((path) => {
  const text = readFileSync(path, "utf8");
  return { file: relative(skillRoot, path), chars: text.length, tokens: tokensOf(text) };
});
const skill = rows.find((r) => r.file === "SKILL.md");
printJson({
  ok: true,
  method: "chars/4",
  skillMd: skill ?? null,
  files: rows,
  totalIfAllLoaded: rows.reduce((n, r) => n + r.tokens, 0),
});
