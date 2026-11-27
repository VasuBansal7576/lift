/**
 * Continuous live recordings for Track 1 / Track 2.
 * Logs in to Flagsmith before ffmpeg starts so credentials are not on screen.
 * Real Flagsmith URLs (public client env key in the path is acceptable).
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { parseArgv } from "../src/config.ts";
import { runOrchestrator } from "../src/conductor.ts";
import { LIVE_PATH, REPO_ROOT } from "../src/paths.ts";

const OUT = resolve(REPO_ROOT, "recordings/t1-t2");
const ARTIFACTS = resolve(REPO_ROOT, "artifacts/t1-t2");
const STORE = "/cursor/stores/self/recordings/t1-t2";
const OPT_ART = "/opt/cursor/artifacts";

function copyOut(file: string) {
  for (const dir of [ARTIFACTS, STORE, OPT_ART]) {
    try {
      mkdirSync(dir, { recursive: true });
      copyFileSync(file, resolve(dir, file.split("/").pop()!));
    } catch {
      /* optional destinations */
    }
  }
}

function startFfmpeg(path: string) {
  mkdirSync(OUT, { recursive: true });
  return spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "x11grab",
      "-video_size",
      "1920x1200",
      "-i",
      ":1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      path,
    ],
    { stdio: "ignore" },
  );
}

async function stopFfmpeg(proc: ReturnType<typeof spawn>) {
  if (proc.exitCode !== null) return;
  proc.kill("SIGINT");
  await new Promise((r) => setTimeout(r, 2000));
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

function requireBootstrapCreds(): { email: string; password: string } {
  const email = process.env.FLAGSMITH_BOOTSTRAP_EMAIL?.trim();
  const password = process.env.FLAGSMITH_BOOTSTRAP_PASSWORD?.trim();
  if (!email || !password) {
    throw new Error("FLAGSMITH_BOOTSTRAP_EMAIL and FLAGSMITH_BOOTSTRAP_PASSWORD are required (no default creds)");
  }
  return { email, password };
}

async function loginFlagsmith(page: import("@playwright/test").Page) {
  const { email, password } = requireBootstrapCreds();
  await page.goto("http://127.0.0.1:8000/login", { waitUntil: "domcontentloaded", timeout: 20_000 });
  const emailBox = page.getByLabel(/email/i);
  await emailBox.waitFor({ timeout: 10_000 });
  await emailBox.fill(email);
  await page.getByLabel(/^password$/i).fill(password);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 15_000 });
}

async function typeApproveOnCamera(experimentId: number): Promise<void> {
  const title = "lift-approve";
  const cmd = `cd ${REPO_ROOT} && npx tsx orchestrator/src/cli.ts --approve ${experimentId} --apply --no-ui; echo DONE; sleep 14`;
  spawn("xterm", ["-T", title, "-geometry", "80x18+20+640", "-fa", "Monospace", "-fs", "14", "-e", "bash", "-lc", cmd], {
    env: { ...process.env, DISPLAY: ":1" },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 5000));
  spawn(
    "xdotool",
    ["search", "--name", title, "windowactivate", "--sync", "type", "--delay", "110", `APPROVE ${experimentId}`],
    { env: { ...process.env, DISPLAY: ":1" }, stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 2800));
  spawn("xdotool", ["search", "--name", title, "windowactivate", "--sync", "key", "Return"], {
    env: { ...process.env, DISPLAY: ":1" },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 16_000));
}

function liveDashboardUrl(): string {
  try {
    const live = JSON.parse(readFileSync(LIVE_PATH, "utf8")) as { dashboardExperimentUrl?: string };
    return live.dashboardExperimentUrl?.trim() || "";
  } catch {
    return "";
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  writeFileSync("/tmp/lift-orch.log", "");
  writeFileSync(LIVE_PATH, "{}\n");
  spawn(
    "xterm",
    ["-geometry", "92x28+0+40", "-fa", "Monospace", "-fs", "12", "-e", "bash", "-lc", "tail -n +1 -f /tmp/lift-orch.log"],
    {
      env: { ...process.env, DISPLAY: ":1" },
      stdio: "ignore",
    },
  );
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    appendFileSync(
      "/tmp/lift-orch.log",
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return origWrite(chunk, ...(rest as []));
  }) as typeof process.stdout.write;

  const browser = await chromium.launch({
    headless: false,
    args: ["--window-position=960,0", "--window-size=960,1200"],
  });
  const context = await browser.newContext({
    viewport: { width: 960, height: 1100 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await loginFlagsmith(page);
  await page.goto("http://127.0.0.1:8000/organisation/1/projects", { waitUntil: "domcontentloaded", timeout: 20_000 });

  async function showExperiment(dashboardUrl: string) {
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(4000);
    if (page.url().includes("login")) {
      throw new Error("Flagsmith session expired; landed on sign-in");
    }
  }

  async function showWinner(dashboardUrl: string, flagName: string) {
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(5000);
    const featuresLink = page.getByRole("link", { name: /^Features$/ });
    if (await featuresLink.count()) {
      await featuresLink.first().click().catch(() => undefined);
      await page.waitForTimeout(2500);
      const row = page.getByText(flagName, { exact: false }).first();
      await row.scrollIntoViewIfNeeded().catch(() => undefined);
      await row.click({ force: true, timeout: 8_000 }).catch(() => undefined);
      await page.waitForTimeout(5000);
    }
    if (page.url().includes("login")) {
      throw new Error("Flagsmith session expired; landed on sign-in");
    }
  }

  async function watchExperiment(stop: { done: boolean }) {
    let last = "";
    while (!stop.done) {
      const url = liveDashboardUrl();
      try {
        if (url && url !== last) {
          last = url;
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
          await page.waitForTimeout(2500);
        } else if (url && !page.url().includes("login")) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
        }
        if (page.url().includes("login")) {
          throw new Error("Flagsmith session expired; landed on sign-in");
        }
      } catch (err) {
        if (String(err).includes("sign-in")) throw err;
      }
      for (let i = 0; i < 16 && !stop.done; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  const t2 = resolve(OUT, "t2-orchestrator-run.mp4");
  const ff = startFfmpeg(t2);
  await page.waitForTimeout(1000);

  const stamp = Date.now().toString().slice(-6);
  const opts = parseArgv([
    "--apply",
    "--keep-ui",
    "--traffic-n",
    "220",
    "--flag-name",
    `lift_orch_t2_${stamp}`,
    "--site-url",
    "http://127.0.0.1:4184/checkout",
    "--ui-port",
    "4177",
  ]);
  const t2Stop = { done: false };
  let t2WatchErr: unknown;
  const t2Watch = watchExperiment(t2Stop).catch((err) => {
    t2WatchErr = err;
  });
  const state = await runOrchestrator(opts);
  t2Stop.done = true;
  await t2Watch;
  if (t2WatchErr) throw t2WatchErr;

  await page.goto("http://127.0.0.1:4177/", { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  if (state.flag?.dashboardUrl) {
    await showExperiment(state.flag.dashboardUrl);
  }

  if (state.recommendation?.kind === "winner" && state.flag) {
    await typeApproveOnCamera(state.flag.experimentId);
    if (state.flag.dashboardUrl) {
      await showExperiment(state.flag.dashboardUrl);
      await showWinner(state.flag.dashboardUrl, state.flag.flagName);
    }
  } else {
    process.stdout.write("No winner yet; --approve skipped (keep collecting).\n");
  }

  await stopFfmpeg(ff);

  const t1 = resolve(OUT, "t1-experiment.mp4");
  const ff1 = startFfmpeg(t1);
  await page.goto("http://127.0.0.1:8000/organisation/1/projects", { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForTimeout(1500);
  await page.getByText("Lift", { exact: true }).nth(1).click();
  await page.waitForTimeout(2000);
  await page.getByRole("link", { name: /^Experiments$/ }).click();
  await page.waitForTimeout(2000);
  if (state.flag) {
    const row = page.getByText(state.flag.flagName, { exact: false }).first();
    await row.scrollIntoViewIfNeeded().catch(() => undefined);
    await row.click({ force: true, timeout: 8_000 }).catch(async () => {
      if (state.flag?.dashboardUrl) await page.goto(state.flag.dashboardUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    });
  }
  await page.waitForTimeout(6000);
  if (page.url().includes("login")) {
    throw new Error("t1 ended on sign-in");
  }
  await stopFfmpeg(ff1);

  const l2 = resolve(OUT, "l2-generation-2.mp4");
  const ff2 = startFfmpeg(l2);
  const opts2 = parseArgv([
    "--apply",
    "--keep-ui",
    "--generations",
    "2",
    "--traffic-n",
    "220",
    "--flag-name",
    `lift_orch_l2_${Date.now().toString().slice(-6)}`,
    "--site-url",
    "http://127.0.0.1:4185/checkout",
    "--ui-port",
    "4178",
  ]);
  writeFileSync(LIVE_PATH, "{}\n");
  const l2Stop = { done: false };
  let l2WatchErr: unknown;
  const l2Watch = watchExperiment(l2Stop).catch((err) => {
    l2WatchErr = err;
  });
  const gen2 = await runOrchestrator(opts2);
  l2Stop.done = true;
  await l2Watch;
  if (l2WatchErr) throw l2WatchErr;
  await page.goto("http://127.0.0.1:4178/", { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  if (gen2.flag?.dashboardUrl) {
    await showExperiment(gen2.flag.dashboardUrl);
  }
  if (gen2.recommendation?.kind === "winner" && gen2.flag) {
    await typeApproveOnCamera(gen2.flag.experimentId);
    if (gen2.flag.dashboardUrl) {
      await showExperiment(gen2.flag.dashboardUrl);
      await showWinner(gen2.flag.dashboardUrl, gen2.flag.flagName);
    }
  }
  if (page.url().includes("login")) {
    throw new Error("l2 ended on sign-in");
  }
  await stopFfmpeg(ff2);

  await context.close();
  await browser.close();

  for (const file of [t2, t1, l2]) {
    if (existsSync(file)) copyOut(file);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : err}\n`);
  process.exit(1);
});
