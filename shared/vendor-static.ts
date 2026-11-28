import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);

/** Map `/vendor/axe.min.js` onto the local axe-core build. Never throws. */
export function resolveVendorPath(pathname: string): string | null {
  if (pathname !== "/vendor/axe.min.js") return null;
  try {
    return nodeRequire.resolve("axe-core/axe.min.js");
  } catch {
    return null;
  }
}
