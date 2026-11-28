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

  it("overlays allowBotOverride onto config.json from LIFT_ALLOW_BOT_OVERRIDE", async () => {
    const previous = process.env.LIFT_ALLOW_BOT_OVERRIDE;
    process.env.LIFT_ALLOW_BOT_OVERRIDE = "true";
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port, path: "/checkout/config.json", method: "GET" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk as Buffer));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          },
        );
        req.on("error", reject);
        req.end();
      });
      const parsed = JSON.parse(body) as { allowBotOverride?: boolean; allowMock?: boolean };
      expect(parsed.allowBotOverride).toBe(true);
      expect(parsed.allowMock).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LIFT_ALLOW_BOT_OVERRIDE;
      else process.env.LIFT_ALLOW_BOT_OVERRIDE = previous;
    }
  });

  it("overlays disableAutofill onto config.json from LIFT_DISABLE_AUTOFILL", async () => {
    const previous = process.env.LIFT_DISABLE_AUTOFILL;
    process.env.LIFT_DISABLE_AUTOFILL = "true";
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port, path: "/checkout/config.json", method: "GET" },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk as Buffer));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          },
        );
        req.on("error", reject);
        req.end();
      });
      const parsed = JSON.parse(body) as { disableAutofill?: boolean };
      expect(parsed.disableAutofill).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.LIFT_DISABLE_AUTOFILL;
      else process.env.LIFT_DISABLE_AUTOFILL = previous;
    }
  });
});

describe("serveSites config overlay without allowMock", () => {
  const port = 4189;
  let server: StaticServer;

  beforeAll(async () => {
    process.env.LIFT_ORCH_FLAG = "lift_orch_unit";
    process.env.FLAGSMITH_ENVIRONMENT_KEY = "env-from-overlay";
    server = await serveSites(port, { allowMock: false });
  });

  afterAll(async () => {
    await server.close();
    delete process.env.LIFT_ORCH_FLAG;
    delete process.env.FLAGSMITH_ENVIRONMENT_KEY;
  });

  it("still serves orch Flagsmith keys when mock override is off", async () => {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path: "/checkout/config.json", method: "GET" },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk as Buffer));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        },
      );
      req.on("error", reject);
      req.end();
    });
    const parsed = JSON.parse(body) as {
      allowMock?: boolean;
      orchFlagName?: string;
      flagsmithEnvironmentKey?: string;
    };
    expect(parsed.allowMock).toBeFalsy();
    expect(parsed.orchFlagName).toBe("lift_orch_unit");
    expect(parsed.flagsmithEnvironmentKey).toBe("env-from-overlay");
  });
});
