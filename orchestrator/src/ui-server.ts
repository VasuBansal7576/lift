import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { parseIncomingUrl } from "../../shared/request-url.ts";
import { isInsideRoot } from "../../shared/fs-path.ts";
import type { EventLog } from "./log.ts";
import { UI_DIR } from "./paths.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export interface UiServer {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function startUiServer(log: EventLog, port: number): Promise<UiServer> {
  const clients = new Set<{ write: (chunk: string) => void; end: () => void }>();
  log.on((event) => {
    const payload = `data: ${JSON.stringify({ event, state: log.livePayload() })}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  });

  const server = createServer(async (req, res) => {
    const url = parseIncomingUrl(req.url, `http://127.0.0.1:${port}`);
    if (!url) {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(log.livePayload()));
      return;
    }
    if (url.pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ state: log.livePayload() })}\n\n`);
      clients.add(res);
      req.on("close", () => {
        clients.delete(res);
      });
      return;
    }
    let relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = resolve(UI_DIR, relative);
    if (!isInsideRoot(UI_DIR, filePath)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "text/plain" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });

  return new Promise((resolveServer, reject) => {
    server.listen(port, "127.0.0.1", () => {
      resolveServer({
        port,
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((resClose, rejClose) => {
            for (const client of clients) {
              try {
                client.end();
              } catch {
                /* ignore */
              }
            }
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Orchestrator UI port ${port} is already in use.`));
        return;
      }
      reject(err);
    });
  });
}
