import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dashboard = process.argv.includes("--dashboard");
const allowMock = process.argv.includes("--allow-mock");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : dashboard ? 4173 : 4174);
const siteRoot = resolve(rootDir, dashboard ? "dashboard" : "sites/checkout");

function isInsideRoot(root, filePath) {
  const base = resolve(root);
  const resolved = resolve(filePath);
  return resolved === base || resolved.startsWith(base + sep);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = resolve(siteRoot, relative);
  if (!isInsideRoot(siteRoot, filePath)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!dashboard && allowMock && relative === "config.json") {
    let parsed = {};
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      parsed = {};
    }
    const body = JSON.stringify({ ...parsed, allowMock: true });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
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
  process.stdout.write(`Serving ${siteRoot} on http://127.0.0.1:${port}\n`);
});
