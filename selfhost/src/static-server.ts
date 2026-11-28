import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export type ExtraRoutes = Record<string, () => Promise<string> | string>;

function inside(root: string, filePath: string): boolean {
  const base = resolve(root);
  const resolved = resolve(filePath);
  return resolved === base || resolved.startsWith(base + sep);
}

export async function serveDir(
  root: string,
  port: number,
  extra: ExtraRoutes = {},
): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const extraBody = extra[url.pathname];
    if (extraBody) {
      try {
        const body = await extraBody();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(body);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    let relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (relative.endsWith("/")) relative += "index.html";
    const filePath = resolve(root, relative);
    if (!inside(root, filePath)) {
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
  const boundPort = await new Promise<number>((resolvePromise, reject) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolvePromise(typeof addr === "object" && addr ? addr.port : port);
    });
    server.on("error", reject);
  });
  return {
    url: `http://127.0.0.1:${boundPort}`,
    server,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      }),
  };
}
