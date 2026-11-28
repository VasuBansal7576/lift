import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { EventLog } from "../../orchestrator/src/log.ts";
import { startUiServer } from "../../orchestrator/src/ui-server.ts";

describe("orchestrator UI server", () => {
  it("fails if the port is already in use", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(4199, "127.0.0.1", () => resolve());
    });
    try {
      await expect(startUiServer(new EventLog(false), 4199)).rejects.toThrow(/already in use/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
