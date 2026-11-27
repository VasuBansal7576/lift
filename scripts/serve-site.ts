import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { getSite, placeholderSiteConfig } from "../shared/catalog.ts";
import { parseIncomingUrl } from "../shared/request-url.ts";
import { resolveRuntimePath } from "../shared/runtime-static.ts";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dashboard = process.argv.includes("--dashboard");
const allowMock = process.argv.includes("--allow-mock");
const edgeOrigin = process.argv.includes("--edge-origin");
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

function overlaySiteConfig(parsed: Record<string, unknown>): string {
  const extra: Record<string, unknown> = {};
  if (allowMock) extra.allowMock = true;
  if (edgeOrigin) extra.edgeOrigin = true;
  if (process.env.LIFT_ALLOW_BOT_OVERRIDE === "true") extra.allowBotOverride = true;
  return JSON.stringify({ ...parsed, ...extra });
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
  try {
    const url = parseIncomingUrl(req.url, `http://127.0.0.1:${port}`);
    if (!url) {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    let runtimePath: string | null = null;
    try {
      runtimePath = resolveRuntimePath(url.pathname, rootDir);
    } catch {
      runtimePath = null;
    }
    if (runtimePath) {
      try {
        const body = await readFile(runtimePath);
        res.writeHead(200, { "Content-Type": MIME[extname(runtimePath)] ?? "application/octet-stream" });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
      return;
    }
    if (!dashboard && url.pathname === "/") {
      res.writeHead(302, { Location: `/checkout/${url.search}` });
      res.end();
      return;
    }
    if (!dashboard && url.pathname.startsWith("/e2e/gzip-")) {
      const small = `<!doctype html><html><head><title>Northline gzip</title></head><body><p id="gzip-mark">small</p></body></html>`;
      let raw: Buffer;
      if (url.pathname === "/e2e/gzip-large") {
        raw = Buffer.from(
          `<!doctype html><html><head><title>large</title></head><body>${"x".repeat(1_048_576 + 64)}</body></html>`,
        );
      } else {
        raw = Buffer.from(small);
      }
      const gz = gzipSync(raw);
      const headers: Record<string, string> = {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Encoding": "gzip",
      };
      if (url.pathname === "/e2e/gzip-chunked") {
        res.writeHead(200, headers);
        const size = 24;
        for (let i = 0; i < gz.length; i += size) {
          res.write(gz.subarray(i, i + size));
        }
        res.end();
        return;
      }
      headers["Content-Length"] = String(gz.length);
      res.writeHead(200, headers);
      res.end(gz);
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
    if (!dashboard && relative.endsWith("config.json")) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      } catch {
        if (allowMock || edgeOrigin) parsed = placeholderFor(relative);
      }
      if (parsed) {
        const body = overlaySiteConfig(parsed);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(body);
        return;
      }
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("error");
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Serving ${siteRoot} on http://127.0.0.1:${port}\n`);
});
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    if (!dashboard) {
      process.stderr.write(
        `Port ${port} already in use. If bots need URL override, start it with npm run site -- --allow-mock.\n`,
      );
    } else {
      process.stderr.write(`Port ${port} already in use.\n`);
    }
    process.exit(1);
  }
  throw err;
});
