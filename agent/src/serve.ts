import { createServer, type Server } from "node:http";
import { extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { isInsideRoot } from "../../shared/fs-path.ts";
import { ROOT } from "./config.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export interface StaticServer {
  close: () => Promise<void>;
  reused: boolean;
}

function overlayAllowMock(body: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return JSON.stringify({ ...parsed, allowMock: true });
}

export function serveSites(
  port: number,
  opts?: { allowMock?: boolean; root?: string },
): Promise<StaticServer> {
  const root = opts?.root ?? resolve(ROOT, "sites");
  const allowMock = opts?.allowMock ?? true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname === "/") {
      res.writeHead(302, { Location: `/checkout/${url.search}` });
      res.end();
      return;
    }
    let relative = url.pathname.slice(1);
    if (relative.endsWith("/")) relative += "index.html";
    const filePath = resolve(root, relative);
    if (!isInsideRoot(root, filePath)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const raw = await readFile(filePath);
      if (allowMock && relative.endsWith("config.json")) {
        const body = overlayAllowMock(raw.toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(body);
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "text/plain" });
      res.end(raw);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return listen(server, port, "sites");
}

function listen(server: Server, port: number, label: string): Promise<StaticServer> {
  return new Promise((resolveServer, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolveServer({
        reused: false,
        close: () =>
          new Promise((resClose, rejClose) => {
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(
          `Port ${port} already in use; reusing the existing ${label} server.\n`,
        );
        resolveServer({ reused: true, close: async () => undefined });
        return;
      }
      reject(err);
    });
  });
}
