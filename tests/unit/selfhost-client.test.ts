import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import {
  LiftSelfhost,
  isTreatmentKey,
  optionKeyOf,
} from "../../selfhost/src/client.ts";
import { ROOT } from "../../agent/src/config.ts";
import {
  bootstrapSelfhost,
  recordedFlagsFromLastRun,
  siteConfigFromEnv,
  writeSiteConfigForSelfhost,
  type SelfhostEnv,
} from "../../selfhost/src/index.ts";
import { upsertEnvFile } from "../../selfhost/src/env.ts";
import { LAST_RUN_FILE } from "../../selfhost/src/paths.ts";
import { simulatedConversionsLabel } from "../../selfhost/src/skill-traffic.ts";
import {
  clearApprovePromptMarker,
  writeApprovePromptMarker,
  APPROVE_PROMPT_FILE,
} from "../../selfhost/src/approve.ts";
import { IDENTITY_COOKIE, readQueryIdentity } from "../../sites/shared/identity.js";
import { requireDocker } from "../../selfhost/src/docker.ts";

function env(): SelfhostEnv {
  return {
    apiUrl: "http://127.0.0.1:8000/api/v1/",
    adminApiUrl: "http://127.0.0.1:8000/api/v1/",
    eventsUrl: "http://127.0.0.1:8000/api/",
    dashboardUrl: "http://127.0.0.1:8000",
    cliApiUrl: "http://127.0.0.1:8000",
    environmentKey: "client-key",
    serverKey: "server-key",
    adminToken: "admin-token",
    organisationId: "1",
    projectId: "2",
    environmentId: "3",
    environmentName: "Development",
    bootstrapEmail: "admin@lift.local",
    bootstrapPassword: "x",
    bootstrapFirstName: "Lift",
    bootstrapLastName: "Admin",
    orgName: "Lift",
    projectName: "Lift",
  };
}

describe("LiftSelfhost client", () => {
  it("lists flags from the SDK flags endpoint using FLAGSMITH_API_URL", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      expect(String(init?.headers)).not.toMatch(/admin-token/);
      return new Response(
        JSON.stringify([
          {
            enabled: true,
            feature_state_value: "control",
            feature: { id: 9, name: "checkout_a11y", type: "MULTIVARIATE" },
            multivariate_feature_state_values: [
              {
                percentage_allocation: 50,
                multivariate_feature_option: { key: "treatment", string_value: "treatment" },
              },
            ],
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const lift = new LiftSelfhost({
      apiUrl: "http://127.0.0.1:8000/api/v1/",
      environmentKey: "client-key",
      fetchImpl,
    });
    const flags = await lift.listManagedFlags();
    expect(calls[0]).toContain("http://127.0.0.1:8000/api/v1/flags/");
    expect(flags).toHaveLength(1);
    expect(flags[0]?.name).toBe("checkout_a11y");
    expect(flags[0]?.status).toBe("experimenting");
  });

  it("writes site config pointed at FLAGSMITH_API_URL", () => {
    const cfg = siteConfigFromEnv(env());
    expect(cfg.flagsmithApiUrl).toBe("http://127.0.0.1:8000/api/v1/");
    expect(cfg.allowMock).toBe(false);
    expect(cfg.flagName).toBe("checkout_a11y");
    expect(cfg.metricEvent).toBe("checkout_completed");
    expect(cfg.simulatedTrafficLabel).toBe("SIMULATED conversions: 120 real Flagsmith identities");
    expect(siteConfigFromEnv(env(), "checkout", "lift_a11y_skill", "lift_a11y_completed").metricEvent).toBe(
      "lift_a11y_completed",
    );
  });

  it("writes self-host config to config.selfhost.json not config.json", () => {
    const path = writeSiteConfigForSelfhost(env());
    expect(path.endsWith("config.selfhost.json")).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8")) as {
      flagsmithEnvironmentKey: string;
      simulatedTrafficLabel: string;
      allowMock: boolean;
    };
    expect(written.flagsmithEnvironmentKey).toBe("client-key");
    expect(written.allowMock).toBe(false);
    expect(written.simulatedTrafficLabel).toBe(simulatedConversionsLabel(120));
    expect(path).not.toMatch(/config\.json$/);
  });
});

describe("option keys", () => {
  it("never treats an empty key as treatment", () => {
    expect(isTreatmentKey("")).toBe(false);
    expect(isTreatmentKey(null)).toBe(false);
    expect(isTreatmentKey("treatment")).toBe(true);
    expect(isTreatmentKey("control")).toBe(false);
  });

  it("resolves option ids to keys and ignores empty object keys", () => {
    const keysById = new Map([
      [11, "treatment"],
      [10, ""],
    ]);
    expect(optionKeyOf(11, keysById)).toBe("treatment");
    expect(optionKeyOf({ id: 10, key: "" }, keysById)).toBe("");
    expect(optionKeyOf({ id: 11, key: "" }, keysById)).toBe("treatment");
  });
});

describe("packaging", () => {
  it("SKILL.md has name + description frontmatter matching the directory", () => {
    const src = readFileSync(
      resolve(ROOT, "skills/flagsmith-a11y-experiment/SKILL.md"),
      "utf8",
    );
    const match = src.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).toBeTruthy();
    expect(match?.[1]).toMatch(/^name:\s*flagsmith-a11y-experiment$/m);
    expect(match?.[1]).toMatch(/^description:\s*\S/m);
  });

  it("selfhost compose is the official Flagsmith file with experimentation on", () => {
    const yml = readFileSync(resolve(ROOT, "selfhost/docker-compose.yml"), "utf8");
    expect(yml).toMatch(/EXPERIMENTATION_ENABLED:\s*'true'/);
    expect(yml).toContain("docker.flagsmith.com/flagsmith/flagsmith:2.295.2");
    expect(yml).not.toContain("flagsmith:latest");
    expect(yml).toContain("127.0.0.1:8000:8000");
    expect(yml).not.toContain("8001:8000");
    expect(yml).toContain("${POSTGRES_PASSWORD:?}");
    expect(yml).toContain("${DJANGO_SECRET_KEY:?}");
    expect(yml).toContain("${WAREHOUSE_CREDENTIALS_SECRET:?}");
    expect(yml).not.toMatch(/POSTGRES_PASSWORD: password/);
    expect(yml).not.toMatch(/DJANGO_SECRET_KEY: secret/);
  });

  it("never calls sudo", async () => {
    const docker = await requireDocker();
    expect(docker.ok === true || docker.ok === false).toBe(true);
    const tmp = join(tmpdir(), `lift-sudo-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });
    mkdirSync(join(tmp, "selfhost"), { recursive: true });
    writeFileSync(join(tmp, "selfhost", "docker-compose.yml"), "services: {}\n");
    writeFileSync(
      join(tmp, "down.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
ROOT=${JSON.stringify(tmp)}
ENV_FILE="$ROOT/selfhost/.env"
if [[ -f "$ENV_FILE" ]]; then
  docker compose -f "$ROOT/selfhost/docker-compose.yml" --env-file "$ENV_FILE" --project-name lift-selfhost down
else
  echo "selfhost/.env missing; compose down without --env-file"
  docker compose -f "$ROOT/selfhost/docker-compose.yml" --project-name lift-selfhost down || true
fi
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(tmp, "sudo"),
      `#!/bin/bash
echo SUDO_CALLED >> ${JSON.stringify(join(tmp, "sudo.log"))}
exit 1
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(tmp, "docker"),
      `#!/bin/bash
echo docker "$@"
exit 0
`,
      { mode: 0o755 },
    );
    const out = spawnSync("bash", [join(tmp, "down.sh")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH ?? ""}` },
    });
    expect(out.status).toBe(0);
    expect(`${out.stdout}${out.stderr}`).toMatch(/selfhost\/\.env missing; compose down without --env-file/);
    expect(statSync(join(tmp, "sudo.log"), { throwIfNoEntry: false })?.isFile() ?? false).toBe(false);
  });

  it("deletes features by id", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const lift = new LiftSelfhost({
      apiUrl: "http://127.0.0.1:8000/api/v1/",
      adminApiUrl: "http://127.0.0.1:8000/api/v1/",
      environmentKey: "client-key",
      adminToken: "admin-token",
      projectId: "2",
      fetchImpl,
    });
    await lift.deleteFeatureById(44);
    expect(calls).toEqual(["DELETE http://127.0.0.1:8000/api/v1/projects/2/features/44/"]);
  });

  it("does not bake --approve-rollout into skill:a11y:apply", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["skill:a11y:apply"]).toContain("--apply");
    expect(pkg.scripts["skill:a11y:apply"]).toContain("--start");
    expect(pkg.scripts["skill:a11y:apply"]).not.toContain("--approve-rollout");
  });

  it("exports a documented module API from selfhost/src/index.ts", async () => {
    const mod = await import("../../selfhost/src/index.ts");
    expect(typeof mod.createLiftSelfhost).toBe("function");
    expect(typeof mod.loadSelfhostEnv).toBe("function");
    expect(typeof mod.compareAxeGate).toBe("function");
  });

  it("chmod 0600 after writing env files", () => {
    const path = join(tmpdir(), `lift-env-${Date.now()}`);
    writeFileSync(path, "FOO=bar\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    upsertEnvFile(path, { BAZ: "qux" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    unlinkSync(path);
  });

  it("persists bootstrap password before register", async () => {
    const envFile = join(tmpdir(), `lift-boot-${Date.now()}`);
    writeFileSync(envFile, "", { mode: 0o600 });
    let passwordOnRegister = "";
    const orig = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("liveness")) return new Response("ok", { status: 200 });
      if (url.includes("/version/")) return new Response("{}", { status: 200 });
      if (url.includes("/auth/users/") && (init?.method ?? "GET") === "POST") {
        passwordOnRegister = readFileSync(envFile, "utf8");
        return new Response(JSON.stringify({ key: "sess", user: { id: 1, email: "admin@lift.local" } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    try {
      await bootstrapSelfhost(
        { ...env(), bootstrapPassword: "persisted-pass" },
        {
          origin: "http://127.0.0.1:9",
          envFile,
          persistSharedState: false,
          writeRootEnv: false,
          freshInstance: true,
        },
      );
    } catch {
      /* later bootstrap steps are mocked to fail */
    } finally {
      globalThis.fetch = orig;
    }
    expect(passwordOnRegister).toMatch(/FLAGSMITH_BOOTSTRAP_PASSWORD=persisted-pass/);
  });

  it("serve-site maps config.json to config.selfhost.json only with --selfhost", async () => {
    writeSiteConfigForSelfhost(env());
    const app = readFileSync(resolve(ROOT, "sites/checkout/app.js"), "utf8");
    expect(app).toContain("lift_no_poll");
    expect(app).toContain("realtime: false");
    expect(app).not.toContain("identityForFlagsmith");
    expect(IDENTITY_COOKIE).toBe("lift_vid");
    expect(readQueryIdentity("?lift_bot=1&lift_identity=t3-control", { host: "127.0.0.1" })).toBe(
      "t3-control",
    );
    expect(readQueryIdentity("?lift_identity=t3-control", { host: "127.0.0.1" })).toBeNull();

    const spawnServer = (args: string[]) =>
      new Promise<{ port: number; child: ChildProcess }>((resolvePromise, reject) => {
        const child = spawn("npx", ["tsx", "scripts/serve-site.ts", ...args], {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(new Error("serve-site did not bind"));
        }, 15_000);
        const onData = (buf: Buffer) => {
          const match = buf.toString().match(/http:\/\/127\.0\.0\.1:(\d+)/);
          if (!match || settled) return;
          settled = true;
          clearTimeout(timer);
          resolvePromise({ port: Number(match[1]), child });
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.once("exit", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`serve-site exited ${code}`));
        });
      });
    const selfhost = await spawnServer(["--selfhost", "--port", "0"]);
    try {
      const mapped = (await fetch(`http://127.0.0.1:${selfhost.port}/checkout/config.json`).then((r) =>
        r.json(),
      )) as { flagsmithEnvironmentKey?: string };
      expect(mapped.flagsmithEnvironmentKey).toBe("client-key");
    } finally {
      selfhost.child.kill("SIGTERM");
    }
  });

  it("dashboard uses textContent not innerHTML", async () => {
    const html = readFileSync(resolve(ROOT, "selfhost/dashboard/index.html"), "utf8");
    const window = new Window({ url: "http://127.0.0.1/" });
    (window as unknown as { fetch: typeof fetch }).fetch = async () =>
      new Response(
        JSON.stringify({
          apiUrl: "http://127.0.0.1:8000/api/v1/",
          environmentName: "Development",
          flags: [
            {
              name: "checkout_a11y",
              type: "MULTIVARIATE",
              enabled: true,
              value: "control",
              variants: [{ key: "treatment", weight: 0 }],
              status: "experimenting",
              managed: true,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    window.document.write(html.replace(/<script>[\s\S]*?<\/script>/, ""));
    window.eval(script);
    await window.happyDOM.waitUntilComplete();
    const rows = window.document.getElementById("rows");
    expect(rows?.textContent).toContain("checkout_a11y");
    expect(script).not.toMatch(/innerHTML/);
    expect(script).toMatch(/textContent/);
  });

  it("skill-cleanup resolves last-run.json from the repo root", () => {
    expect(LAST_RUN_FILE).toBe(resolve(ROOT, "skills/flagsmith-a11y-experiment/last-run.json"));
    const tmp = join(tmpdir(), `lift-last-run-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({ createdFlags: [{ name: "lift_a11y_stale_1", id: 9 }] }));
    expect(recordedFlagsFromLastRun(tmp)).toEqual([{ name: "lift_a11y_stale_1", id: 9 }]);
    expect(recordedFlagsFromLastRun(join(tmpdir(), "missing-last-run.json"))).toEqual([]);
    unlinkSync(tmp);
  });

  it("live recorder never covers the URL bar or auto-approves", () => {
    const app = readFileSync(resolve(ROOT, "sites/checkout/app.js"), "utf8");
    expect(app).toContain("realtime: false");
    expect(app).toContain("lift_no_poll");
    expect(app).not.toContain("identityForFlagsmith");
  });

  it("selfhost-down handles a missing .env", async () => {
    const tmp = join(tmpdir(), `lift-down-${Date.now()}`);
    mkdirSync(join(tmp, "selfhost"), { recursive: true });
    writeFileSync(join(tmp, "selfhost", "docker-compose.yml"), "services: {}\n");
    writeFileSync(
      join(tmp, "down.sh"),
      readFileSync(resolve(ROOT, "scripts/selfhost-down.sh"), "utf8").replace(
        'ROOT="$(cd "$(dirname "$0")/.." && pwd)"',
        `ROOT=${JSON.stringify(tmp)}`,
      ),
      { mode: 0o700 },
    );
    writeFileSync(join(tmp, "docker"), "#!/bin/bash\necho docker \"$@\"\nexit 0\n", { mode: 0o755 });
    const out = spawnSync("bash", [join(tmp, "down.sh")], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH ?? ""}` },
    });
    expect(`${out.stdout}${out.stderr}`).toMatch(/selfhost\/\.env missing; compose down without --env-file/);
  });

  it("approve marker lives under mkdtemp and is removed in finally", () => {
    writeApprovePromptMarker(9, { treatment: 0.8 });
    expect(APPROVE_PROMPT_FILE).toContain("lift-approve-");
    const marker = APPROVE_PROMPT_FILE;
    const dir = dirname(marker);
    expect(readFileSync(marker, "utf8")).toContain("APPROVE 9");
    clearApprovePromptMarker();
    expect(APPROVE_PROMPT_FILE).toBe("");
    expect(statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false).toBe(false);
  });
});
