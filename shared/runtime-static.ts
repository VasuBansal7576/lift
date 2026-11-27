import { resolve } from "node:path";
import { isInsideRoot } from "./fs-path.ts";

/** Map `/runtime/...` URLs onto files under `<repo>/runtime/`. */
export function resolveRuntimePath(pathname: string, repoRoot: string): string | null {
  if (!pathname.startsWith("/runtime/")) return null;
  const relative = decodeURIComponent(pathname.slice(1));
  const filePath = resolve(repoRoot, relative);
  const runtimeRoot = resolve(repoRoot, "runtime");
  if (!isInsideRoot(runtimeRoot, filePath)) return null;
  return filePath;
}
