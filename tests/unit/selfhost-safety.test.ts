import { describe, expect, it } from "vitest";
import { parseArgs } from "../../selfhost/src/args.ts";
import { compareAxeGate } from "../../selfhost/src/axe-gate.ts";
import { flagStatus, isManagedFlagName, parseSdkFlags } from "../../selfhost/src/flags.ts";
import { assertNoServerKeyVisible, maskKey, redactSecrets } from "../../selfhost/src/redact.ts";
import {
  assertSafeToMutate,
  isLoopbackUrl,
  isProductionEnvironmentName,
  wantApply,
} from "../../selfhost/src/safety.ts";
import { splitApiUrl } from "../../selfhost/src/env.ts";
import { planOrRefuse, rolloutWinner } from "../../selfhost/src/skill-ops.ts";
import { LiftSelfhost } from "../../selfhost/src/client.ts";

describe("selfhost safety", () => {
  it("treats Development as non-production and Production as production", () => {
    expect(isProductionEnvironmentName("Development")).toBe(false);
    expect(isProductionEnvironmentName("Production")).toBe(true);
    expect(isProductionEnvironmentName("prod")).toBe(true);
  });

  it("refuses production mutations without --confirm-prod", () => {
    const refused = assertSafeToMutate({ environmentName: "Production", confirmProd: false });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected refuse");
    expect(refused.code).toBe("production");
    expect(assertSafeToMutate({ environmentName: "Production", confirmProd: true }).ok).toBe(true);
  });

  it("defaults to dry-run unless --apply", () => {
    expect(wantApply({})).toBe(false);
    expect(wantApply({ apply: true })).toBe(true);
    expect(wantApply({ apply: true, "dry-run": true })).toBe(false);
  });

  it("treats loopback hosts as local and everything else as remote", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8000/api/v1/")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8000")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8000/")).toBe(true);
    expect(isLoopbackUrl("https://api.flagsmith.com/api/v1/")).toBe(false);
    expect(isLoopbackUrl("not-a-url")).toBe(false);
  });

  it("default-denies non-loopback Admin/SDK URLs unless --allow-remote", () => {
    const refused = assertSafeToMutate({
      environmentName: "Development",
      apiUrl: "https://edge.api.flagsmith.com/api/v1/",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected refuse");
    expect(refused.code).toBe("remote");
    expect(
      assertSafeToMutate({
        environmentName: "Development",
        apiUrl: "https://edge.api.flagsmith.com/api/v1/",
        allowRemote: true,
      }).ok,
    ).toBe(true);
    expect(
      assertSafeToMutate({
        environmentName: "Production",
        apiUrl: "https://api.flagsmith.com/api/v1/",
        allowRemote: true,
        confirmProd: false,
      }).ok,
    ).toBe(false);
    expect(
      assertSafeToMutate({
        environmentName: "Production",
        apiUrl: "https://api.flagsmith.com/api/v1/",
        allowRemote: true,
        confirmProd: true,
      }).ok,
    ).toBe(true);
    expect(
      assertSafeToMutate({
        environmentName: "Development",
        apiUrl: "http://127.0.0.1:8000/api/v1/",
        eventsUrl: "https://events.flagsmith.com/",
      }).ok,
    ).toBe(false);
    expect(
      assertSafeToMutate({
        environmentName: "Development",
        apiUrl: "http://127.0.0.1:8000/api/v1/",
        cliApiUrl: "https://api.flagsmith.com",
      }).ok,
    ).toBe(false);
  });
});

describe("redact", () => {
  it("never leaves API keys in output", () => {
    const raw = 'Authorization: Api-Key ser.secret\nFLAGSMITH_ADMIN_API_TOKEN=abc\n{"token":"nope"}';
    const out = redactSecrets(raw);
    expect(out).not.toMatch(/ser\.secret/);
    expect(redactSecrets("server key ser.abc-DEF_12 leaked")).toBe("server key ser.[REDACTED] leaked");
    expect(out).not.toMatch(/TOKEN=abc/);
    expect(out).not.toMatch(/"nope"/);
    expect(out).toMatch(/\[REDACTED\]/);
    expect(maskKey("abcdefghij")).toBe("…ghij");
  });

  it("redacts configured environmentKey, serverKey and adminToken values", () => {
    const prev = {
      FLAGSMITH_ENVIRONMENT_KEY: process.env.FLAGSMITH_ENVIRONMENT_KEY,
      FLAGSMITH_SERVER_KEY: process.env.FLAGSMITH_SERVER_KEY,
      FLAGSMITH_ADMIN_API_TOKEN: process.env.FLAGSMITH_ADMIN_API_TOKEN,
    };
    process.env.FLAGSMITH_ENVIRONMENT_KEY = "env-public-xyz";
    process.env.FLAGSMITH_SERVER_KEY = "ser.configuredkeyvalue";
    process.env.FLAGSMITH_ADMIN_API_TOKEN = "admin-token-xyz";
    try {
      const out = redactSecrets("enroll wait env-public-xyz admin-token-xyz ser.configuredkeyvalue");
      expect(out).not.toContain("env-public-xyz");
      expect(out).not.toContain("admin-token-xyz");
      expect(out).not.toContain("ser.configuredkeyvalue");
      expect(out).toMatch(/\[REDACTED\]/);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("throws when a server-style key would be visible", () => {
    expect(() => assertNoServerKeyVisible("api_key ser.secret does not exist")).toThrow(/server-style ser/);
    expect(() => assertNoServerKeyVisible("health-poll 3 liveness HTTP 200")).not.toThrow();
  });
});

describe("axe gate", () => {
  it("rejects a variant that adds a new rule", () => {
    const gate = compareAxeGate(
      [{ id: "button-name", nodes: 1 }],
      [
        { id: "button-name", nodes: 1 },
        { id: "label", nodes: 1 },
      ],
    );
    expect(gate.rejected).toBe(true);
    expect(gate.addedIds).toEqual(["label"]);
  });

  it("rejects a variant that increases node count", () => {
    const gate = compareAxeGate(
      [{ id: "button-name", nodes: 1 }],
      [{ id: "button-name", nodes: 3 }],
    );
    expect(gate.rejected).toBe(true);
    expect(gate.increased[0]?.to).toBe(3);
  });

  it("passes when the variant only removes violations", () => {
    const gate = compareAxeGate(
      [
        { id: "button-name", nodes: 2 },
        { id: "label", nodes: 1 },
      ],
      [{ id: "button-name", nodes: 1 }],
    );
    expect(gate.ok).toBe(true);
    expect(gate.rejected).toBe(false);
  });
});

describe("flag parsing", () => {
  it("marks lift/checkout flags as managed and rolled_out at 100% treatment", () => {
    const flags = parseSdkFlags([
      {
        enabled: true,
        feature_state_value: "control",
        feature: { id: 1, name: "checkout_a11y", type: "MULTIVARIATE" },
        multivariate_feature_state_values: [
          {
            percentage_allocation: 100,
            multivariate_feature_option: { key: "treatment", string_value: "treatment" },
          },
        ],
      },
    ]);
    expect(flags[0]?.managed).toBe(true);
    expect(flags[0]?.status).toBe("rolled_out");
    expect(isManagedFlagName("other_flag")).toBe(false);
    expect(flagStatus(false, [])).toBe("off");
  });
});

describe("api url split", () => {
  it("gives CLI origin without /api/v1 and SDK with it", () => {
    const split = splitApiUrl("http://127.0.0.1:8000/api/v1/");
    expect(split.origin).toBe("http://127.0.0.1:8000");
    expect(split.sdk).toBe("http://127.0.0.1:8000/api/v1/");
  });
});

describe("parseArgs", () => {
  it("parses --apply and --name", () => {
    const { flags } = parseArgs(["--apply", "--name", "lift_a11y_skill", "--confirm-prod"]);
    expect(flags.apply).toBe(true);
    expect(flags.name).toBe("lift_a11y_skill");
    expect(flags["confirm-prod"]).toBe(true);
  });
});

describe("skill ops", () => {
  it("planOrRefuse blocks production", () => {
    const out = planOrRefuse({ environmentName: "prod", confirmProd: false, apply: true });
    expect(out.ok).toBe(false);
  });

  it("rollout without approval returns WAITING_FOR_HUMAN_APPROVAL", async () => {
    const lift = new LiftSelfhost({
      apiUrl: "http://127.0.0.1:8000/api/v1/",
      environmentKey: "env",
      adminToken: "token",
    });
    const out = await rolloutWinner(
      lift,
      { environmentName: "Development", confirmProd: false, apply: false },
      { flagName: "lift_a11y_skill" },
    );
    expect(out.waiting).toBe(true);
    expect(out.code).toBe("WAITING_FOR_HUMAN_APPROVAL");
  });
});
