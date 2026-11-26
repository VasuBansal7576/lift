import { sep, resolve } from "node:path";

/** True when `filePath` is `root` or a file inside it (not a prefix sibling). */
export function isInsideRoot(root: string, filePath: string): boolean {
  const base = resolve(root);
  const resolved = resolve(filePath);
  return resolved === base || resolved.startsWith(base + sep);
}
