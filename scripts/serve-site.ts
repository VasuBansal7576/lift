import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getSite, placeholderSiteConfig } from "../shared/catalog.ts";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dashboard = process.argv.includes("--dashboard");
const allowMock = process.argv.includes("--allow-mock");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg >= 0 ? process.argv[portArg + 1] : dashboard ? 4173 : 4174);
const siteRoot = resolve(rootDir, dashboard ? "dashboard" : "sites");

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
};

function overlayAllowMock(parsed: Record<string, unknown>): string {
  return JSON.stringify({ ...parsed, allowMock: true });
}

function placeholderFor(relative: string): Record<string, unknown> {
  const match = relative.match(/^([^/]+)\/config\.json$/);
  if (!match) return {};
  try {
    return placeholderSiteConfig(getSite(match[1])) as unknown as Record<string, unknown>;
  } catch {
    return {};
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (!dashboard && url.pathname === "/") {
    res.writeHead(302, { Location: `/checkout/${url.search}` });
    res.end();
    return;
  }
  let relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (relative.endsWith("/")) relative += "index.html";
  const filePath = resolve(siteRoot, relative);
  if (!isInsideRoot(siteRoot, filePath)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!dashboard && allowMock && relative.endsWith("config.json")) {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    } catch {
      parsed = placeholderFor(relative);
    }
    const body = overlayAllowMock(parsed);
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
