import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { AXE_GATE_RULES } from "../../shared/patch-spec.ts";

async function pause(page: Page, ms = 1600) {
  await page.waitForTimeout(ms);
}

async function showBanner(page: Page, text: string) {
  await page.evaluate((message) => {
    let el = document.getElementById("lift-evidence-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "lift-evidence-banner";
      el.setAttribute("data-evidence", "1");
      el.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px 18px;font:600 18px/1.4 system-ui,sans-serif;background:#111;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.45)";
      document.body.prepend(el);
    }
    el.textContent = message;
  }, text);
  await pause(page);
}

async function axeSummary(page: Page) {
  const results = await new AxeBuilder({ page }).include("body").analyze();
  const gate = results.violations.filter((v) =>
    (AXE_GATE_RULES as readonly string[]).includes(v.id),
  );
  return {
    total: results.violations.length,
    gate: gate.map((v) => v.id),
    ids: results.violations.map((v) => v.id),
  };
}

async function openCheckout(page: Page) {
  await page.locator(".hover-nav").hover();
  await pause(page, 600);
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
}

async function applyTreatment(page: Page) {
  return page.evaluate(async () => {
    const runtimeHref = new URL("/runtime/runtime.js", location.origin).href;
    const specHref = new URL("/runtime/checkout-treatment.json", location.origin).href;
    const runtime = (await import(runtimeHref)) as {
      applyPatchSpec: (spec: unknown) => { ok: boolean; error?: string };
    };
    const spec = await fetch(specHref).then((res) => res.json());
    return runtime.applyPatchSpec(spec);
  });
}

async function fillCheckout(page: Page) {
  await page.locator("#email").fill("ada@northline.test");
  await page.locator("#card-name").fill("Ada Lovelace");
  await page.locator("#card-number").fill("4242424242424242");
  await page.locator("#card-exp").fill("12/28");
  await page.locator("#card-cvc").fill("123");
}

async function paintIdentityReadout(page: Page) {
  return page.evaluate(() => {
    let el = document.getElementById("lift-cookie-readout");
    if (!el) {
      el = document.createElement("pre");
      el.id = "lift-cookie-readout";
      el.setAttribute("data-evidence", "1");
      el.style.cssText =
        "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;margin:0;padding:12px 18px;font:16px/1.4 ui-monospace,monospace;background:#063;color:#fff;white-space:pre-wrap";
      document.body.append(el);
    }
    const cookie = document.cookie;
    const variant = document.body.getAttribute("data-variant") ?? "";
    const status = document.getElementById("flag-status")?.textContent ?? "";
    el.textContent = `document.cookie=${cookie}\ndata-variant=${variant}\n#flag-status=${status}`;
    return { cookie, variant, status, text: el.textContent };
  });
}

test("01-control-barriers", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  await showBanner(page, "CONTROL — hover to open Shop, unlabeled icon, unlabeled fields, low contrast, div Pay");
  await openCheckout(page);
  const axe = await axeSummary(page);
  await showBanner(
    page,
    `CONTROL axe: ${axe.total} violations — gate [${axe.gate.join(", ") || "none"}]`,
  );
  for (const rule of AXE_GATE_RULES) {
    expect(axe.gate, `control should violate ${rule}`).toContain(rule);
  }
  await expect(page.locator("#shop-trigger")).toHaveJSProperty("tagName", "SPAN");
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  await pause(page, 2000);
});

test("02-treatment-before-after", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckout(page);
  const beforeAxe = await axeSummary(page);
  await showBanner(
    page,
    `BEFORE runtime spec — ${beforeAxe.total} axe violations, gate [${beforeAxe.gate.join(", ")}]`,
  );
  await expect(page.locator("#place-order")).toHaveJSProperty("tagName", "DIV");
  const applied = await applyTreatment(page);
  expect(applied.ok).toBe(true);
  await pause(page, 800);
  await expect(page.locator("#shop-trigger")).toHaveRole("button");
  await expect(page.locator('label[for="email"]')).toHaveText("Email");
  await expect(page.locator("#place-order")).toHaveRole("button");
  await expect(page.locator("#place-order")).toHaveText("Place order");
  const afterAxe = await axeSummary(page);
  const leftoverNote =
    "leftover region on .sim-banner — fixture demo note sits outside header/main landmarks; not a gate rule (label/button-name/color-contrast); replaceTag cannot emit landmark tags";
  await showBanner(
    page,
    `AFTER runtime.js spec — ${afterAxe.total} axe violations (was ${beforeAxe.total}); gate [${afterAxe.gate.join(", ") || "cleared"}]; ${leftoverNote}`,
  );
  expect(afterAxe.gate, "treatment should clear the axe gate").toEqual([]);
  expect(afterAxe.ids, "one leftover non-gate region on the demo banner").toEqual(["region"]);
  expect(afterAxe.total).toBeLessThan(beforeAxe.total);
  await page.locator("#place-order").focus();
  await pause(page, 2000);
});

test("03-keyboard-submit-once", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await page.evaluate(() => {
    (window as unknown as { __payClicks: number }).__payClicks = 0;
    document.getElementById("place-order")?.addEventListener("click", () => {
      (window as unknown as { __payClicks: number }).__payClicks += 1;
    });
  });
  expect((await applyTreatment(page)).ok).toBe(true);
  await showBanner(
    page,
    "KEYBOARD — hover Shop (page CSS owns display; injectCSS v0 cannot emit display/combinators), fill, Tab to Place order, one Enter",
  );
  await openCheckout(page);
  await fillCheckout(page);
  await page.locator("#terms").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  await expect(page.locator("#place-order")).toBeFocused();
  await showBanner(page, "Place order focused — pressing Enter once");
  await page.keyboard.press("Enter");
  const clicks = await page.evaluate(
    () => (window as unknown as { __payClicks: number }).__payClicks,
  );
  expect(clicks).toBe(1);
  await expect(page.locator("#confirmation")).toBeVisible();
  await showBanner(page, `SUBMITTED — original click handlers fired ${clicks} time (want 1)`);
  await pause(page, 2000);
});

test("04-comment-smuggle", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckout(page);
  const before = await page.evaluate(() => ({
    pay: document.getElementById("place-order")?.outerHTML ?? "",
    html: document.body.innerHTML.length,
  }));
  await showBanner(page, 'FAIL-OPEN — injectCSS raw text h1{color:"/*"; background-image:url(...)} is unrepresentable');
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    return runtime.applyPatchSpec({
      id: "evil-comment",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          css: 'h1{color:"/*"; background-image:url(http://x/leak) /* */}',
        },
      ],
    });
  });
  expect(result.ok).toBe(false);
  const after = await page.evaluate(() => ({
    pay: document.getElementById("place-order")?.outerHTML ?? "",
  }));
  expect(after.pay).toBe(before.pay);
  await showBanner(
    page,
    `REJECTED comment-smuggle (${result.error ?? "not allowlisted"}) — Place order markup unchanged`,
  );
  await pause(page, 2000);
});

test("04-is-body-opacity", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await openCheckout(page);
  const before = await page.evaluate(() => ({
    pay: document.getElementById("place-order")?.outerHTML ?? "",
    opacity: getComputedStyle(document.body).opacity,
  }));
  await showBanner(page, "FAIL-OPEN — :is(body){opacity:0} is unrepresentable (no :is, no body, no opacity)");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    return runtime.applyPatchSpec({
      id: "evil-is-body",
      version: 0,
      ops: [{ op: "injectCSS", css: ":is(body){opacity:0}" }],
    });
  });
  expect(result.ok).toBe(false);
  const after = await page.evaluate(() => ({
    pay: document.getElementById("place-order")?.outerHTML ?? "",
    opacity: getComputedStyle(document.body).opacity,
  }));
  expect(after.pay).toBe(before.pay);
  expect(after.opacity).toBe(before.opacity);
  await showBanner(
    page,
    `REJECTED :is(body){opacity:0} (${result.error ?? "not allowlisted"}) — body opacity ${after.opacity}`,
  );
  await pause(page, 2000);
});

test("05-sticky-identity", async ({ page }) => {
  await page.goto("/checkout/");
  await page.waitForTimeout(1500);
  const flagsmithReady = await page.evaluate(() => {
    const variant = document.body.getAttribute("data-variant");
    return variant === "control" || variant === "treatment";
  });
  if (!flagsmithReady) {
    await page.goto("/checkout/?lift_variant=control");
    await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  }
  const first = await paintIdentityReadout(page);
  expect(first.cookie).toMatch(/lift_vid=/);
  await showBanner(page, `IDENTITY first load (from page) ${first.text.replaceAll("\n", " | ")}`);
  await page.reload();
  if (!flagsmithReady) {
    await expect(page.locator("body")).toHaveAttribute("data-variant", "control");
  } else {
    await expect(page.locator("body")).toHaveAttribute("data-variant", first.variant);
  }
  const again = await paintIdentityReadout(page);
  expect(again.cookie).toBe(first.cookie);
  expect(again.variant).toBe(first.variant);
  await showBanner(page, `IDENTITY after reload (from page) ${again.text.replaceAll("\n", " | ")} — same document.cookie`);
  await pause(page, 2000);
});
