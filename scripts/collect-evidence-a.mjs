#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(process.env.EVIDENCE_DIR || join(repoRoot, "artifacts/fir-9-a"));
const PLAY = join(ROOT, "playwright");
const NAMES = [
  "01-control-barriers",
  "02-treatment-before-after",
  "03-keyboard-submit-once",
  "04-typed-body-tag",
  "04-typed-opacity",
  "04-typed-not-state",
  "04-typed-body-class-anchor",
  "04-typed-color-eq-background",
  "04-typed-hover-invisible",
  "04-replace-button-to-span",
  "04-late-content",
  "04-descendant-contrast",
  "04-submit-button-kept",
  "04-focus-within-color",
  "04-covered-control",
  "05-sticky-identity",
];

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function largest(paths) {
  return paths
    .map((p) => ({ p, size: statSync(p).size }))
    .sort((a, b) => b.size - a.size)[0]?.p;
}

mkdirSync(ROOT, { recursive: true });
const files = walk(PLAY);
let missing = 0;
for (const key of NAMES) {
  const video = largest(files.filter((p) => p.includes(key) && extname(p) === ".webm"));
  const trace = largest(
    files.filter((p) => p.includes(key) && (p.endsWith(".zip") || p.endsWith("trace.zip"))),
  );
  if (video) {
    const dest = join(ROOT, `${key}.webm`);
    copyFileSync(video, dest);
    process.stdout.write(`video ${dest}\n`);
  }
  if (trace) {
    const dest = join(ROOT, `${key}.trace.zip`);
    copyFileSync(trace, dest);
    process.stdout.write(`trace ${dest}\n`);
  }
  if (!video) {
    process.stderr.write(`missing video for ${key}\n`);
    missing += 1;
  }
  if (!trace) {
    process.stderr.write(`missing trace for ${key}\n`);
    missing += 1;
  }
}
if (missing) process.exit(1);
