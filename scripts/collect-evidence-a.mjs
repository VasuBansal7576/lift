#!/usr/bin/env node
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = "/opt/cursor/artifacts/fir-9-a";
const PLAY = join(ROOT, "playwright");
const NAMES = [
  "01-control-barriers",
  "02-treatment-before-after",
  "03-keyboard-submit-once",
  "04-malicious-fail-open",
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
  if (!video) process.stderr.write(`missing video for ${key}\n`);
  if (!trace) process.stderr.write(`missing trace for ${key}\n`);
}
