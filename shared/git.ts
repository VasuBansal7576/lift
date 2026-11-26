import { execSync } from "node:child_process";

/** Append `-dirty` when the working tree is not clean. Leaves `unknown` alone. */
export function formatGitCommitSha(sha: string, dirty: boolean): string {
  if (!sha || sha === "unknown") return sha || "unknown";
  if (dirty && !sha.endsWith("-dirty")) return `${sha}-dirty`;
  return sha;
}

export function gitWorkingTreeDirty(): boolean {
  try {
    const out = execSync("git status --porcelain", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

/** Commit SHA that produced this run. Env wins so tests do not shell out. */
export function gitCommitSha(): string {
  const fromEnv = (process.env.LIFT_COMMIT_SHA || process.env.GITHUB_SHA || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const sha = execSync("git rev-parse HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return formatGitCommitSha(sha, gitWorkingTreeDirty());
  } catch {
    return "unknown";
  }
}
