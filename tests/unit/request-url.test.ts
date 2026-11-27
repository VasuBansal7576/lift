import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveSites, type StaticServer } from "../../agent/src/serve.ts";
import { parseIncomingUrl } from "../../shared/request-url.ts";

describe("parseIncomingUrl", () => {
  it("parses a normal path", () => {
    const url = parseIncomingUrl("/runtime/runtime.js", "http://127.0.0.1:4174");
    expect(url?.pathname).toBe("/runtime/runtime.js");
  });

  it("rejects protocol-relative and cross-origin URLs", () => {
    expect(parseIncomingUrl("//", "http://127.0.0.1:4174")).toBeNull();
    expect(parseIncomingUrl("//evil.example/", "http://127.0.0.1:4174")).toBeNull();
  });
});

describe("serveSites GET //", () => {
  const port = 4188;
  let server: StaticServer;

  beforeAll(async () => {
    server = await serveSites(port, { allowMock: true });
  });

  afterAll(async () => {
    await server.close();
  });

  it("returns 400 and does not throw", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "//", method: "GET" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
  });
});
