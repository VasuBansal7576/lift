import { resolve } from "node:path";
import { isInsideRoot } from "./fs-path.ts";

/** Map `/runtime/...` URLs onto files under `<repo>/runtime/`. Never throws. */
export function resolveRuntimePath(pathname: string, repoRoot: string): string | null {
  if (!pathname.startsWith("/runtime/")) return null;
  if (/%00/i.test(pathname)) return null;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(1));
  } catch {
    return null;
  }
  if (relative.includes("\0")) return null;
  const filePath = resolve(repoRoot, relative);
  const runtimeRoot = resolve(repoRoot, "runtime");
  if (!isInsideRoot(runtimeRoot, filePath)) return null;
  return filePath;
}
