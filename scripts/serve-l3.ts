import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const demoRoot = resolve(rootDir, "demo/l3");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : 4175);

function isInsideRoot(root: string, filePath: string) {
  const base = resolve(root);
  const resolved = resolve(filePath);
  return resolved === base || resolved.startsWith(base + sep);
}

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  let relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (relative.endsWith("/")) relative += "index.html";

  let filePath: string;
  let allowedRoot: string;
  if (relative.startsWith("runtime/")) {
    filePath = resolve(rootDir, relative);
    allowedRoot = resolve(rootDir, "runtime");
  } else {
    filePath = resolve(demoRoot, relative);
    allowedRoot = demoRoot;
  }
  if (!isInsideRoot(allowedRoot, filePath) && !isInsideRoot(rootDir, filePath)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

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
