import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const demoRoot = resolve(rootDir, "demo/l3");
const runtimeRoot = resolve(rootDir, "runtime");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : 4175);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

const SECRET_MARKERS = [
  "FLAGSMITH_ADMIN_API_TOKEN",
  "FLAGSMITH_BOOTSTRAP_PASSWORD",
  "FLAGSMITH_SERVER_KEY",
];

function isInsideRoot(root: string, filePath: string) {
  const base = resolve(root);
  const resolved = resolve(filePath);
  return resolved === base || resolved.startsWith(base + sep);
}

export function isBlockedBasename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "flagsmith.env" || lower === ".env" || lower.startsWith(".env.");
}

export function containsSecretKeys(text: string): boolean {
  return SECRET_MARKERS.some((marker) => text.includes(marker));
}

export function resolveL3PublicPath(urlPath: string): { status: number; filePath?: string } {
  let pathname = urlPath.split("?")[0] || "/";
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }
  if (pathname.includes("\0") || pathname.includes("\\")) return { status: 403 };
  if (pathname.split("/").includes("..")) return { status: 403 };
  let relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relative.endsWith("/")) relative += "index.html";
  if (!relative || relative.includes("..")) return { status: 403 };

  const name = basename(relative);
  if (isBlockedBasename(name)) return { status: 403 };

  let filePath: string;
  let allowedRoot: string;
  if (relative === "runtime" || relative.startsWith("runtime/")) {
    filePath = resolve(rootDir, relative);
    allowedRoot = runtimeRoot;
  } else {
    filePath = resolve(demoRoot, relative);
    allowedRoot = demoRoot;
  }
  if (!isInsideRoot(allowedRoot, filePath)) return { status: 403 };
  return { status: 200, filePath };
}

export async function handleL3Request(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const resolved = resolveL3PublicPath(url.pathname);
  if (resolved.status !== 200 || !resolved.filePath) {
    res.writeHead(resolved.status === 200 ? 403 : resolved.status);
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(resolved.filePath);
    if (containsSecretKeys(body.toString("utf8"))) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(resolved.filePath)] ?? "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

export function createL3Server() {
  return createServer((req, res) => {
    void handleL3Request(req, res);
  });
}

const thisFile = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain =
  thisFile === invoked || process.argv.some((arg) => arg.endsWith("serve-l3.ts"));
if (isMain) {
  const server = createL3Server();
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Serving Lift L3 demo on http://127.0.0.1:${port}\n`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(`Port ${port} already in use.\n`);
      process.exit(1);
    }
    throw err;
  });
}
