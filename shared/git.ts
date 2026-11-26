import { execSync } from "node:child_process";

/** Commit SHA that produced this run. Env wins so tests do not shell out. */
export function gitCommitSha(): string {
  const fromEnv = (process.env.LIFT_COMMIT_SHA || process.env.GITHUB_SHA || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return "unknown";
  }
}
