import http from "node:http";
import { expect, test } from "@playwright/test";

const SITE_PORT = Number(process.env.LIFT_PORT || process.env.PORT || 4174);
import {
  CSS_ATTACKS,
  CSS_TYPED_ACCEPTED,
  INSERT_HTML_ATTACKS,
} from "../fixtures/patch-spec-corpus.ts";

test("Chromium rejects the CSS attack corpus through runtime.js", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const results = await page.evaluate(async (attacks) => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      parsePatchSpec: (input: unknown) => { ok: boolean };
    };
    return attacks.map((attack) => ({
      name: attack.name,
      parsed: runtime.parsePatchSpec(attack.spec).ok,
    }));
  }, CSS_ATTACKS);
  for (const result of results) {
    expect(result.parsed, result.name).toBe(false);
  }
});

test("Chromium rejects the insertHTML attack corpus through runtime.js", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const results = await page.evaluate(async (attacks) => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      parsePatchSpec: (input: unknown) => { ok: boolean };
    };
    return attacks.map((attack) => ({
      name: attack.name,
      parsed: runtime.parsePatchSpec(attack.spec).ok,
    }));
  }, INSERT_HTML_ATTACKS);
  for (const result of results) {
    expect(result.parsed, result.name).toBe(false);
  }
});

test("Chromium refuses setText into an injected style tag", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const cssOp = {
      op: "injectCSS",
      id: "s1",
      rules: [
        {
          selector: { classes: ["x"] },
          declarations: [{ property: "color", value: "#111" }],
        },
      ],
    };
    document.body.insertAdjacentHTML("beforeend", `<span class="x">x</span>`);
    runtime.applyPatchSpec({
      id: "css",
      version: 0,
      ops: [cssOp],
    });
    const before = document.getElementById("lift-patch-css-s1")?.textContent ?? "";
    const applied = runtime.applyPatchSpec({
      id: "set-style",
      version: 0,
      ops: [
        {
          op: "setText",
          selector: "#lift-patch-css-s1",
          text: "body { color: #000; }",
        },
      ],
    });
    return {
      ok: applied.ok,
      error: applied.error,
      after: document.getElementById("lift-patch-css-s1")?.textContent ?? "",
      before,
    };
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("target is not allowlisted");
  expect(result.after).toBe(result.before);
});

test("one Enter on the replaced Place order button fires one original click", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await page.evaluate(() => {
    (window as unknown as { __payClicks: number }).__payClicks = 0;
    document.getElementById("place-order")?.addEventListener("click", () => {
      (window as unknown as { __payClicks: number }).__payClicks += 1;
    });
  });
  const applied = await page.evaluate(async () => {
    const runtimeHref = new URL("/runtime/runtime.js", location.origin).href;
    const specHref = new URL("/runtime/checkout-treatment.json", location.origin).href;
    const runtime = (await import(runtimeHref)) as {
      applyPatchSpec: (spec: unknown) => { ok: boolean };
    };
    const spec = await fetch(specHref).then((res) => res.json());
    return runtime.applyPatchSpec(spec);
  });
  expect(applied.ok).toBe(true);
  await page.locator(".hover-nav").hover();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  await page.locator("#email").fill("ada@northline.test");
  await page.locator("#card-name").fill("Ada Lovelace");
  await page.locator("#card-number").fill("4242424242424242");
  await page.locator("#card-exp").fill("12/28");
  await page.locator("#card-cvc").fill("123");
  await page.locator("#terms").check();
  await page.locator("#place-order").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as unknown as { __payClicks: number }).__payClicks)).toBe(
    1,
  );
  await expect(page.locator("#confirmation")).toBeVisible();
});

test("setText refuses targets with element children", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const applied = runtime.applyPatchSpec({
      id: "settext-main",
      version: 0,
      ops: [{ op: "setText", selector: "main", text: "wiped" }],
    });
    return {
      ok: applied.ok,
      stillHasForm: Boolean(document.getElementById("checkout-form")),
      stillHasPay: Boolean(document.getElementById("place-order")),
    };
  });
  expect(result.ok).toBe(false);
  expect(result.stillHasForm).toBe(true);
  expect(result.stillHasPay).toBe(true);
});

test("chained promoteToControl forwards one click to the original node", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const clicks = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "chain-pay";
    host.textContent = "Pay";
    host.style.cursor = "pointer";
    document.body.append(host);
    let n = 0;
    host.addEventListener("click", () => {
      n += 1;
    });
    runtime.applyPatchSpec({
      id: "chain-1",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#chain-pay", as: "button" }],
    });
    runtime.applyPatchSpec({
      id: "chain-1",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#chain-pay", as: "button" }],
    });
    document.getElementById("chain-pay")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return {
      n,
      tag: document.getElementById("chain-pay")?.tagName ?? "",
      role: document.getElementById("chain-pay")?.getAttribute("role") ?? "",
      same: document.getElementById("chain-pay") === host,
    };
  });
  expect(clicks.tag).toBe("DIV");
  expect(clicks.role).toBe("button");
  expect(clicks.same).toBe(true);
  expect(clicks.n).toBe(1);
});

test("promoteToControl on a class selector is idempotent", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    document.body.insertAdjacentHTML(
      "beforeend",
      `<span class="lift-chip-test" style="cursor:pointer">Go</span>`,
    );
    const spec = {
      id: "class-promote",
      version: 0,
      ops: [{ op: "promoteToControl", selector: ".lift-chip-test", as: "button" }],
    };
    const first = runtime.applyPatchSpec(spec);
    const second = runtime.applyPatchSpec(spec);
    return {
      first: first.ok,
      second: second.ok,
      buttons: document.querySelectorAll("button.lift-chip-test").length,
      spans: document.querySelectorAll("span.lift-chip-test").length,
      role: document.querySelector("span.lift-chip-test")?.getAttribute("role") ?? "",
    };
  });
  expect(result.first).toBe(true);
  expect(result.second).toBe(true);
  expect(result.buttons).toBe(0);
  expect(result.spans).toBe(1);
  expect(result.role).toBe("button");
});

test("injectCSS with the same id updates css and undo restores the previous text", async ({
  page,
}) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    document.body.insertAdjacentHTML("beforeend", `<span class="a">a</span>`);
    const rule = (color: string) => ({
      op: "injectCSS",
      id: "s1",
      rules: [
        {
          selector: { classes: ["a"] },
          declarations: [{ property: "color", value: color }],
        },
      ],
    });
    runtime.applyPatchSpec({
      id: "css-1",
      version: 0,
      ops: [rule("#111")],
    });
    const afterFirst = document.getElementById("lift-patch-css-s1")?.textContent ?? "";
    runtime.applyPatchSpec({
      id: "css-2",
      version: 0,
      ops: [rule("#222")],
    });
    const afterSecond = document.getElementById("lift-patch-css-s1")?.textContent ?? "";
    const rolled = runtime.applyPatchSpec({
      id: "css-3",
      version: 0,
      ops: [rule("#333"), { op: "setText", selector: "#missing", text: "nope" }],
    });
    return {
      afterFirst,
      afterSecond,
      afterRollback: document.getElementById("lift-patch-css-s1")?.textContent ?? "",
      rolledOk: rolled.ok,
      styleCount: document.querySelectorAll("[data-lift-css]").length,
    };
  });
  expect(result.afterFirst).toContain("#111");
  expect(result.afterSecond).toContain("#222");
  expect(result.rolledOk).toBe(false);
  expect(result.afterRollback).toContain("#222");
  expect(result.styleCount).toBe(1);
});

test("Chromium rejects string-hidden CSS comments and :is(body)", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      parsePatchSpec: (input: unknown) => { ok: boolean };
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const smuggle = {
      id: "smuggle",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          css: 'h1{color:"/*"; background-image:url(http://x/leak) /* */}',
        },
      ],
    };
    const isBody = {
      id: "is-body",
      version: 0,
      ops: [{ op: "injectCSS", css: ":is(body){opacity:0}" }],
    };
    const before = getComputedStyle(document.body).opacity;
    const applied = runtime.applyPatchSpec(isBody);
    return {
      smuggleOk: runtime.parsePatchSpec(smuggle).ok,
      isBodyOk: runtime.parsePatchSpec(isBody).ok,
      appliedOk: applied.ok,
      opacity: getComputedStyle(document.body).opacity,
      before,
    };
  });
  expect(result.smuggleOk).toBe(false);
  expect(result.isBodyOk).toBe(false);
  expect(result.appliedOk).toBe(false);
  expect(result.opacity).toBe(result.before);
});

test("Chromium refuses setText into an SVG <style>", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.id = "svg-style";
    style.textContent = ".x{fill:red}";
    svg.append(style);
    document.body.append(svg);
    const before = style.textContent;
    const applied = runtime.applyPatchSpec({
      id: "svg-style-text",
      version: 0,
      ops: [{ op: "setText", selector: "#svg-style", text: "url(http://evil.example)" }],
    });
    return { ok: applied.ok, after: style.textContent, before };
  });
  expect(result.ok).toBe(false);
  expect(result.after).toBe(result.before);
});

test("Chromium refuses replaceTag body and setText head", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const pay = document.getElementById("place-order")?.outerHTML ?? "";
    const body = runtime.applyPatchSpec({
      id: "kill-body",
      version: 0,
      ops: [{ op: "replaceTag", selector: "body", tag: "span" }],
    });
    const head = runtime.applyPatchSpec({
      id: "kill-head",
      version: 0,
      ops: [{ op: "setText", selector: "head", text: "gone" }],
    });
    return {
      bodyOk: body.ok,
      headOk: head.ok,
      stillHasPay: Boolean(document.getElementById("place-order")),
      pay,
      payNow: document.getElementById("place-order")?.outerHTML ?? "",
      title: document.title,
    };
  });
  expect(result.bodyOk).toBe(false);
  expect(result.headOk).toBe(false);
  expect(result.stillHasPay).toBe(true);
  expect(result.payNow).toBe(result.pay);
});

test("Chromium rejects replaceTag to <a> without href", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      parsePatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    return runtime.parsePatchSpec({
      id: "a-no-href",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#place-order", tag: "a" }],
    });
  });
  expect(result.ok).toBe(false);
  expect(result.error).toContain("promoteToControl");
});

test("bindEnterToClick on a non-native replacement forwards one click", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const counts = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "lift-enter-once";
    host.style.cursor = "pointer";
    host.textContent = "Pay";
    document.body.append(host);
    let clicks = 0;
    let keys = 0;
    host.addEventListener("click", () => {
      clicks += 1;
    });
    host.addEventListener("keydown", () => {
      keys += 1;
    });
    runtime.applyPatchSpec({
      id: "enter-once",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#lift-enter-once", as: "button" }],
    });
    document
      .getElementById("lift-enter-once")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { clicks, keys, tag: document.getElementById("lift-enter-once")?.tagName ?? "" };
  });
  expect(counts.tag).toBe("DIV");
  expect(counts.clicks).toBe(1);
  expect(counts.keys).toBe(1);
});

test("Chromium computed styles of accepted typed CSS stay in bounds", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async (accepted) => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const host = document.createElement("div");
    host.id = "lift-css-probe";
    document.body.append(host);
    const reports: { name: string; ok: boolean; error?: string; styles: Record<string, string> }[] =
      [];
    for (const item of accepted) {
      host.replaceChildren();
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = "probe";
      if (item.probe.attr === "id") el.id = item.probe.value;
      else el.className = item.probe.value;
      host.append(el);
      const applied = runtime.applyPatchSpec({
        id: `css-${item.name}`,
        version: 0,
        ops: [{ op: "injectCSS", rules: item.rules }],
      });
      if (item.probe.state === "focus") el.focus();
      const computed = getComputedStyle(el);
      reports.push({
        name: item.name,
        ok: applied.ok,
        error: applied.error,
        styles: {
          color: computed.color,
          backgroundColor: computed.backgroundColor,
          outlineWidth: computed.outlineWidth,
          outlineOffset: computed.outlineOffset,
          borderWidth: computed.borderTopWidth,
          fontSize: computed.fontSize,
          fontWeight: computed.fontWeight,
          lineHeight: computed.lineHeight,
          letterSpacing: computed.letterSpacing,
          wordSpacing: computed.wordSpacing,
          textDecorationThickness: computed.textDecorationThickness,
          minHeight: computed.minHeight,
          minWidth: computed.minWidth,
          padding: computed.paddingTop,
          cursor: computed.cursor,
          opacity: computed.opacity,
        },
      });
    }
    return reports;
  }, CSS_TYPED_ACCEPTED);
  for (const report of result) {
    expect(report.ok, `${report.name}: ${report.error ?? ""}`).toBe(true);
    const px = (raw: string) => Number.parseFloat(raw);
    expect(["1", "1.0"], report.name).toContain(report.styles.opacity);
    if (report.styles.outlineWidth !== "0px") {
      expect(px(report.styles.outlineWidth), report.name).toBeGreaterThanOrEqual(1);
      expect(px(report.styles.outlineWidth), report.name).toBeLessThanOrEqual(8);
    }
    if (report.styles.outlineOffset !== "0px") {
      expect(px(report.styles.outlineOffset), report.name).toBeGreaterThanOrEqual(0);
      expect(px(report.styles.outlineOffset), report.name).toBeLessThanOrEqual(8);
    }
    if (report.name === "font and spacing" || report.name === "font-size rem") {
      expect(px(report.styles.fontSize), report.name).toBeGreaterThanOrEqual(12);
      expect(px(report.styles.fontSize), report.name).toBeLessThanOrEqual(48 * 3);
    }
    if (report.name === "decoration target padding cursor") {
      expect(px(report.styles.minHeight), report.name).toBeLessThanOrEqual(64);
      expect(px(report.styles.minWidth), report.name).toBeLessThanOrEqual(64);
      expect(px(report.styles.padding), report.name).toBeLessThanOrEqual(24);
      expect(report.styles.cursor, report.name).toMatch(/pointer|default/);
    }
    expect(report.styles.color, report.name).toMatch(/^rgb\(/);
    expect(report.styles.color, report.name).not.toMatch(/rgba\(|\//);
  }
});

test("bindEnterToClick ignores Enter on descendants", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const counts = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "lift-enter-host";
    host.innerHTML = `Pay<span id="lift-enter-kid">x</span>`;
    document.body.append(host);
    let clicks = 0;
    host.addEventListener("click", () => {
      clicks += 1;
    });
    const nested = runtime.applyPatchSpec({
      id: "enter-nested",
      version: 0,
      ops: [
        {
          op: "bindEnterToClick",
          selector: "#checkout-form",
        },
      ],
    });
    const applied = runtime.applyPatchSpec({
      id: "enter-host",
      version: 0,
      ops: [{ op: "bindEnterToClick", selector: "#lift-enter-host" }],
    });
    document
      .getElementById("lift-enter-kid")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const afterChild = clicks;
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { nestedOk: nested.ok, appliedOk: applied.ok, afterChild, clicks };
  });
  expect(counts.nestedOk).toBe(false);
  expect(counts.appliedOk).toBe(true);
  expect(counts.afterChild).toBe(0);
  expect(counts.clicks).toBe(1);
});

test("R7 E1 Chromium keeps an existing submit button submittable", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const form = document.createElement("form");
    form.id = "pay-form";
    const button = document.createElement("button");
    button.id = "pay-go";
    button.type = "submit";
    button.textContent = "Pay";
    form.appendChild(button);
    document.body.appendChild(form);
    let submits = 0;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submits += 1;
    });
    const applied = runtime.applyPatchSpec({
      id: "keep-submit",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#pay-go", tag: "button" }],
    });
    button.click();
    return {
      ok: applied.ok,
      type: button.getAttribute("type"),
      tag: button.tagName,
      submits,
    };
  });
  expect(result.ok).toBe(false);
  expect(result.type).toBe("submit");
  expect(result.tag).toBe("BUTTON");
  expect(result.submits).toBe(1);
});

test("R7 E2 Chromium rejects focus-within color", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const parsed = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      parsePatchSpec: (input: unknown) => { ok: boolean };
    };
    return runtime.parsePatchSpec({
      id: "fw",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["x"], state: "focus-within" },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    }).ok;
  });
  expect(parsed).toBe(false);
});

test("R7 W1 Chromium undoes a covering cookie bar", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      setTestBackstopsPaused: (paused: boolean) => boolean;
    };
    const buy = document.createElement("button");
    buy.id = "buy";
    buy.type = "button";
    buy.textContent = "Buy";
    buy.style.cssText = "position:fixed;top:240px;left:40px;z-index:1;padding:12px 28px";
    const bar = document.createElement("div");
    bar.className = "cookie-bar";
    bar.textContent = "Cookies";
    bar.style.cssText =
      "position:fixed;top:200px;left:0;right:0;z-index:9;background:#111;color:#fff";
    document.body.append(bar, buy);
    runtime.setTestBackstopsPaused(true);
    const applied = runtime.applyPatchSpec({
      id: "cover",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["cookie-bar"] },
              declarations: [
                { property: "font-size", value: "48px" },
                { property: "padding", value: "24px" },
                { property: "min-height", value: "64px" },
                { property: "line-height", value: 3 },
              ],
            },
          ],
        },
      ],
    });
    const rect = buy.getBoundingClientRect();
    const coveredWhilePaused = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    runtime.setTestBackstopsPaused(false);
    const after = buy.getBoundingClientRect();
    const restored = document.elementFromPoint(
      after.left + after.width / 2,
      after.top + after.height / 2,
    );
    return {
      paused: applied.ok,
      covered:
        coveredWhilePaused !== buy &&
        coveredWhilePaused !== null &&
        !buy.contains(coveredWhilePaused),
      restored: restored === buy || Boolean(buy.contains(restored)),
      cssAfter: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ),
    };
  });
  expect(result.paused).toBe(true);
  expect(result.covered).toBe(true);
  expect(result.restored).toBe(true);
  expect(result.cssAfter).toBe(false);
});

test("R7 W1 Chromium refuses size-growing on a clipping card", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const ok = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const card = document.createElement("div");
    card.className = "card";
    card.style.cssText = "height:90px;overflow:hidden";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Buy";
    card.appendChild(button);
    document.body.appendChild(card);
    return runtime.applyPatchSpec({
      id: "clip",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["card"] },
              declarations: [{ property: "padding", value: "24px" }],
            },
          ],
        },
      ],
    }).ok;
  });
  expect(ok).toBe(false);
});

test("R7 W3 Chromium guard runs within 250ms under continuous mutations", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const theme = document.createElement("style");
    theme.textContent = ".slot { color: #fff; background-color: #111; }";
    document.head.append(theme);
    const slot = document.createElement("span");
    slot.className = "slot";
    slot.textContent = "ok";
    document.body.appendChild(slot);
    const applied = runtime.applyPatchSpec({
      id: "max-wait",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["slot"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    const started = performance.now();
    const burst = window.setInterval(() => {
      document.body.classList.toggle("busy");
      document.body.setAttribute("data-tick", String(Date.now()));
    }, 10);
    const ghost = document.createElement("span");
    ghost.style.color = "#fff";
    ghost.textContent = "hid";
    slot.append(ghost);
    await new Promise((resolve) => {
      const check = () => {
        const live = [...document.querySelectorAll("[data-lift-css]")].some(
          (el) => el instanceof HTMLStyleElement && !el.disabled,
        );
        if (!live) {
          resolve(undefined);
          return;
        }
        if (performance.now() - started > 400) {
          resolve(undefined);
          return;
        }
        window.setTimeout(check, 16);
      };
      check();
    });
    window.clearInterval(burst);
    return {
      applied: applied.ok,
      undone: ![...document.querySelectorAll("[data-lift-css]")].some(
        (el) => el instanceof HTMLStyleElement && !el.disabled,
      ),
      ms: performance.now() - started,
    };
  });
  expect(result.applied).toBe(true);
  expect(result.undone).toBe(true);
  expect(result.ms).toBeLessThan(300);
});

async function measureGuardTick(
  page: import("@playwright/test").Page,
  nodeCount: number,
  linkCount: number,
) {
  return page.evaluate(async ({ nodes, links }) => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      setTestBackstopsPaused: (paused: boolean) => boolean;
    };
    const host = document.createElement("div");
    host.id = `perf-host-${nodes}`;
    const probe = document.createElement("span");
    probe.className = "probe";
    probe.textContent = "x";
    host.appendChild(probe);
    const chunk = document.createDocumentFragment();
    for (let i = 0; i < nodes; i += 1) {
      const node = document.createElement("span");
      node.textContent = "n";
      chunk.appendChild(node);
    }
    for (let i = 0; i < links; i += 1) {
      const a = document.createElement("a");
      a.href = `#n${i}`;
      a.textContent = "go";
      chunk.appendChild(a);
    }
    host.appendChild(chunk);
    document.body.appendChild(host);
    const spec = {
      id: `perf-${nodes}-${links}`,
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["probe"] },
              declarations: [
                { property: "min-height", value: "44px" },
                { property: "min-width", value: "44px" },
              ],
            },
          ],
        },
      ],
    };
    void host.offsetHeight;
    const b0 = performance.now();
    void host.offsetHeight;
    const baselineMs = performance.now() - b0;
    void host.offsetHeight;
    const t0 = performance.now();
    const applied = runtime.applyPatchSpec(spec);
    void host.offsetHeight;
    const applyMs = performance.now() - t0;
    runtime.setTestBackstopsPaused(true);
    document.body.classList.add("tick");
    document.body.setAttribute("data-perf", String(nodes));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const t1 = performance.now();
    runtime.setTestBackstopsPaused(false);
    const guardMs = performance.now() - t1;
    return { ok: applied.ok, applyMs, guardMs, baselineMs };
  }, { nodes: nodeCount, links: linkCount });
}

test("R10 I2 Chromium size-growing coverage ticks at 10k/50, 10k/400, 30k/3000", async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const tiny = await measureGuardTick(page, 10_000, 50);
  console.log(
    `perf-10k/50 applyMs=${tiny.applyMs.toFixed(2)} guardMs=${tiny.guardMs.toFixed(2)} baselineMs=${tiny.baselineMs.toFixed(2)}`,
  );
  expect(tiny.ok).toBe(true);
  const mid = await measureGuardTick(page, 10_000, 400);
  console.log(
    `perf-10k/400 applyMs=${mid.applyMs.toFixed(2)} guardMs=${mid.guardMs.toFixed(2)} baselineMs=${mid.baselineMs.toFixed(2)}`,
  );
  expect(mid.ok).toBe(true);
  const large = await measureGuardTick(page, 30_000, 3000);
  console.log(
    `perf-30k/3000 applyMs=${large.applyMs.toFixed(2)} guardMs=${large.guardMs.toFixed(2)} baselineMs=${large.baselineMs.toFixed(2)}`,
  );
  expect(large.ok).toBe(true);
  expect(large.guardMs).toBeLessThan(60);

  const idle = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      getRuntimeStats: () => { ticksRan: number; ticksSkipped: number };
      resetRuntimeGuards?: () => void;
    };
    runtime.resetRuntimeGuards?.();
    const host = document.createElement("div");
    host.innerHTML = `<a class="probe" href="#p" style="color:#111;background:#fff">Go</a>`;
    document.body.append(host);
    runtime.applyPatchSpec({
      id: "idle-perf",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["probe"] },
              declarations: [
                { property: "min-height", value: "44px" },
                { property: "min-width", value: "44px" },
              ],
            },
          ],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const start = runtime.getRuntimeStats();
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    const end = runtime.getRuntimeStats();
    return {
      ran: end.ticksRan - start.ticksRan,
      skipped: end.ticksSkipped - start.ticksSkipped,
    };
  });
  console.log(`perf-idle-10s ticksRan=${idle.ran} ticksSkipped=${idle.skipped}`);
  expect(idle.ran).toBe(0);

  const ticker = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      getRuntimeStats: () => { ticksRan: number; ticksSkipped: number; tickMsMax: number };
    };
    const host = document.createElement("div");
    host.id = "ticker-host";
    host.innerHTML = `<a class="probe2" href="#p" style="color:#111;background:#fff">Go</a>`;
    document.body.append(host);
    runtime.applyPatchSpec({
      id: "ticker-perf",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["probe2"] },
              declarations: [
                { property: "min-height", value: "44px" },
                { property: "min-width", value: "44px" },
              ],
            },
          ],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const start = runtime.getRuntimeStats();
    let n = 0;
    const id = setInterval(() => {
      n += 1;
      host.setAttribute("data-tick", String(n));
    }, 16);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    clearInterval(id);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const end = runtime.getRuntimeStats();
    return {
      ran: end.ticksRan - start.ticksRan,
      skipped: end.ticksSkipped - start.ticksSkipped,
      tickMsMax: end.tickMsMax,
    };
  });
  console.log(
    `perf-ticker-10s ticksRan=${ticker.ran} ticksSkipped=${ticker.skipped} tickMsMax=${ticker.tickMsMax}`,
  );
  expect(ticker.ran).toBeGreaterThan(0);
  expect(ticker.ran).toBeLessThan(400);
  expect(ticker.tickMsMax).toBeLessThan(150);
});

test("R8 E1 Chromium re-apply keeps undos across a theme flip", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const style = document.createElement("style");
    style.textContent = ".panel { color: #fff; background-color: #111; }";
    document.head.append(style);
    const panel = document.createElement("div");
    panel.id = "panel";
    panel.className = "panel";
    panel.textContent = "Hello";
    document.body.append(panel);
    const spec = {
      id: "reapply-guard",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["panel"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    };
    const first = runtime.applyPatchSpec(spec);
    const second = runtime.applyPatchSpec(spec);
    const ghost = document.createElement("span");
    ghost.style.color = "#fff";
    ghost.textContent = "hid";
    panel.append(ghost);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      first: first.ok,
      second: second.ok,
      css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ),
    };
  });
  expect(result.first).toBe(true);
  expect(result.second).toBe(true);
  expect(result.css).toBe(false);
});

test("R8 E2 Chromium two-rule guard continues after the first selector vanishes", async ({
  page,
}) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const pageStyle = document.createElement("style");
    pageStyle.textContent = ".keep { color: #fff; background-color: #111; }";
    document.head.append(pageStyle);
    document.body.insertAdjacentHTML("beforeend", `<span id="gone">A</span><span class="keep">B</span>`);
    const applied = runtime.applyPatchSpec({
      id: "two-rules",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "gone" },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
            {
              selector: { classes: ["keep"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    document.getElementById("gone")?.remove();
    const keep = document.querySelector(".keep");
    const ghost = document.createElement("span");
    ghost.style.color = "#fff";
    ghost.textContent = "hid";
    keep?.append(ghost);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: applied.ok, css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ) };
  });
  expect(result.ok).toBe(true);
  expect(result.css).toBe(false);
});

test("R8 W2 Chromium undoes insertRule via resize", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const slot = document.createElement("span");
    slot.className = "slot";
    slot.textContent = "ok";
    document.body.append(slot);
    const applied = runtime.applyPatchSpec({
      id: "cssom",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["slot"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    const sheet = (document.querySelector("[data-lift-css]") as HTMLStyleElement | null)?.sheet;
    sheet?.insertRule(".slot { color: rgb(255, 255, 255); }", sheet.cssRules.length);
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: applied.ok, css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ) };
  });
  expect(result.ok).toBe(true);
  expect(result.css).toBe(false);
});

test("R8 W3 Chromium refuses underline on line-through text", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    document.body.insertAdjacentHTML(
      "beforeend",
      `<span class="struck" style="text-decoration-line:line-through">old</span><del class="deleted">gone</del>`,
    );
    const struck = runtime.applyPatchSpec({
      id: "underline-struck",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["struck"] },
              declarations: [{ property: "text-decoration-line", value: "underline" }],
            },
          ],
        },
      ],
    });
    const deleted = runtime.applyPatchSpec({
      id: "underline-del",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["deleted"] },
              declarations: [{ property: "text-decoration-line", value: "underline" }],
            },
          ],
        },
      ],
    });
    return { struck: struck.ok, deleted: deleted.ok };
  });
  expect(result.struck).toBe(false);
  expect(result.deleted).toBe(false);
});

test("R8 W4 Chromium refuses outline-width plus offset over 4px", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      parsePatchSpec: (input: unknown) => { ok: boolean };
    };
    return runtime.parsePatchSpec({
      id: "outline-sum",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["x"], state: "focus" },
              declarations: [
                { property: "outline-style", value: "solid" },
                { property: "outline-color", value: "#000" },
                { property: "outline-width", value: "3px" },
                { property: "outline-offset", value: "2px" },
              ],
            },
          ],
        },
      ],
    }).ok;
  });
  expect(result).toBe(false);
});

test("R8 I4 resetRuntimeGuards is only on window under lift_bot=1", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const ungated = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    await import(href);
    return typeof (window as unknown as { LiftRuntime?: { resetRuntimeGuards?: unknown } })
      .LiftRuntime?.resetRuntimeGuards;
  });
  expect(ungated).toBe("undefined");
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const gated = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    await import(href);
    return typeof (window as unknown as { LiftRuntime?: { resetRuntimeGuards?: unknown } })
      .LiftRuntime?.resetRuntimeGuards;
  });
  expect(gated).toBe("function");
});

test("R8 I5 Chromium guard covers a newly added focusable under an overlay", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      setTestBackstopsPaused: (paused: boolean) => boolean;
    };
    const bar = document.createElement("div");
    bar.className = "cover-bar";
    bar.textContent = "Cookies";
    bar.style.cssText =
      "position:fixed;top:200px;left:0;right:0;height:80px;z-index:9;background:#111;color:#fff";
    document.body.append(bar);
    runtime.setTestBackstopsPaused(true);
    const applied = runtime.applyPatchSpec({
      id: "new-focusable",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["cover-bar"] },
              declarations: [
                { property: "color", value: "#fff" },
                { property: "background-color", value: "#111" },
              ],
            },
          ],
        },
      ],
    });
    const buy = document.createElement("button");
    buy.type = "button";
    buy.textContent = "Buy";
    buy.style.cssText = "position:fixed;top:210px;left:40px;z-index:1;padding:12px 28px";
    document.body.append(buy);
    runtime.setTestBackstopsPaused(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { paused: applied.ok, css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ) };
  });
  expect(result.paused).toBe(true);
  expect(result.css).toBe(true);
});

test("R9 W1 Chromium host Enter handler activates once", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "no-double";
    host.style.cursor = "pointer";
    host.textContent = "Pay";
    document.body.append(host);
    const log: string[] = [];
    host.addEventListener("keydown", (event) => {
      log.push("ownkey");
      event.preventDefault();
      host.click();
    });
    host.addEventListener("click", () => {
      log.push("click");
    });
    runtime.applyPatchSpec({
      id: "no-double",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#no-double", as: "button" }],
    });
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const space = document.createElement("div");
    space.id = "space-once";
    space.style.cursor = "pointer";
    space.textContent = "Go";
    document.body.append(space);
    let spaceClicks = 0;
    space.addEventListener("click", () => {
      spaceClicks += 1;
    });
    runtime.applyPatchSpec({
      id: "space-once",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#space-once", as: "button" }],
    });
    space.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    space.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, repeat: true }));
    space.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, repeat: true }));
    space.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, repeat: true }));
    space.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { log, clicks: log.filter((x) => x === "click").length, spaceClicks };
  });
  expect(result.log).toEqual(["ownkey", "click"]);
  expect(result.clicks).toBe(1);
  expect(result.spaceClicks).toBe(1);
});

test("R9 W2 Chromium promote gates reject hidden/inert/empty/contenteditable", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div aria-hidden="true"><div id="hid" style="cursor:pointer">Go</div></div>
       <div inert><div id="inert" style="cursor:pointer">Go</div></div>
       <div id="ce" contenteditable="true" style="cursor:pointer">Go</div>
       <div id="empty" style="cursor:pointer"></div>
       <div id="ok" style="cursor:pointer">Go</div>
       <div id="neg" tabindex="-1" style="cursor:pointer">Go</div>`,
    );
    const hid = runtime.applyPatchSpec({
      id: "hid",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#hid", as: "button" }],
    });
    const inert = runtime.applyPatchSpec({
      id: "inert",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#inert", as: "button" }],
    });
    const ce = runtime.applyPatchSpec({
      id: "ce",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#ce", as: "button" }],
    });
    const empty = runtime.applyPatchSpec({
      id: "empty",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#empty", as: "button" }],
    });
    const ok = runtime.applyPatchSpec({
      id: "ok",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#ok", as: "button" }],
    });
    const neg = runtime.applyPatchSpec({
      id: "neg",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#neg", as: "button" }],
    });
    return {
      hid: hid.ok,
      inert: inert.ok,
      ce: ce.ok,
      empty: empty.ok,
      ok: ok.ok,
      negTab: document.getElementById("neg")?.tabIndex ?? -99,
    };
  });
  expect(result.hid).toBe(false);
  expect(result.inert).toBe(false);
  expect(result.ce).toBe(false);
  expect(result.empty).toBe(false);
  expect(result.ok).toBe(true);
  expect(result.negTab).toBe(0);
});

test("R9 W3 Chromium page-caused modal keeps the fix and spec-caused still undoes", async ({
  page,
}) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const keep = document.createElement("button");
    keep.type = "button";
    keep.className = "keep";
    keep.textContent = "Keep";
    document.body.append(keep);
    const modalApplied = runtime.applyPatchSpec({
      id: "page-modal",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["keep"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    keep.hidden = true;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const modalCss = [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          );
    const pageStyle = document.createElement("style");
    pageStyle.textContent = ".panel { color: #fff; background-color: #111; }";
    document.head.append(pageStyle);
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.textContent = "Hello";
    document.body.append(panel);
    const specApplied = runtime.applyPatchSpec({
      id: "spec-caused",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["panel"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    const ghost = document.createElement("span");
    ghost.style.color = "#fff";
    ghost.textContent = "hid";
    panel.append(ghost);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      modalApplied: modalApplied.ok,
      modalCss,
      specApplied: specApplied.ok,
      specCss: Boolean(document.querySelector('#spec-caused, [data-lift-css]')),
      panelCss: [...document.querySelectorAll("[data-lift-css]")].some(
        (el) =>
          el instanceof HTMLStyleElement &&
          !el.disabled &&
          (el.textContent || "").includes(".panel"),
      ),
    };
  });
  expect(result.modalApplied).toBe(true);
  expect(result.modalCss).toBe(true);
  expect(result.specApplied).toBe(true);
  expect(result.panelCss).toBe(false);
});

test("R9 W3 Chromium insertRule on open checkout undoes after pause", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await page.locator(".hover-nav").hover();
  await page.locator("#checkout-link").click();
  await page.locator("#checkout").waitFor({ state: "visible" });
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      setTestBackstopsPaused: (paused: boolean) => boolean;
    };
    const pageStyle = document.createElement("style");
    pageStyle.textContent = ".slot { color: #16181d; background-color: #fff; }";
    document.head.append(pageStyle);
    const checkout = document.getElementById("checkout") || document.body;
    const slot = document.createElement("span");
    slot.className = "slot";
    slot.textContent = "CSSOM slot";
    checkout.append(slot);
    const applied = runtime.applyPatchSpec({
      id: "cssom-checkout",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["slot"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    runtime.setTestBackstopsPaused(true);
    const banner = document.createElement("div");
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px;background:#111;color:#fff";
    banner.textContent = "evidence banner";
    document.body.prepend(banner);
    const sheet = (document.querySelector("[data-lift-css]") as HTMLStyleElement | null)?.sheet;
    sheet?.insertRule(".slot { color: rgb(255, 255, 255); }", sheet.cssRules.length);
    slot.style.outline = "3px dashed #f00";
    slot.style.outlineOffset = "2px";
    const range = document.createRange();
    range.selectNodeContents(slot);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    runtime.setTestBackstopsPaused(false);
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    return {
      ok: applied.ok,
      css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ),
      color: getComputedStyle(slot).color,
      attr: (window as unknown as { __LIFT_ATTR__?: unknown }).__LIFT_ATTR__ ?? null,
      failOpen: (window as unknown as { __LIFT_FAIL_OPEN__?: unknown }).__LIFT_FAIL_OPEN__ ?? null,
    };
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, css: false });
});

test("R9 W3 Chromium insertRule contrast undoes even with a covering banner", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      setTestBackstopsPaused: (paused: boolean) => boolean;
    };
    const pageStyle = document.createElement("style");
    pageStyle.textContent = ".slot { color: #16181d; background-color: #fff; }";
    document.head.append(pageStyle);
    const slot = document.createElement("span");
    slot.className = "slot";
    slot.textContent = "CSSOM slot";
    document.body.append(slot);
    const applied = runtime.applyPatchSpec({
      id: "cssom-banner",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["slot"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    runtime.setTestBackstopsPaused(true);
    const banner = document.createElement("div");
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:14px;background:#111;color:#fff";
    banner.textContent = "evidence banner";
    document.body.prepend(banner);
    const sheet = (document.querySelector("[data-lift-css]") as HTMLStyleElement | null)?.sheet;
    sheet?.insertRule(".slot { color: rgb(255, 255, 255); }", sheet.cssRules.length);
    runtime.setTestBackstopsPaused(false);
    window.dispatchEvent(new Event("resize"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      ok: applied.ok,
      css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ),
      color: getComputedStyle(slot).color,
    };
  });
  expect(result.ok).toBe(true);
  expect(result.css).toBe(false);
});

test("R10 I1 Chromium rejects a grown sticky link that covers Buy", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    document.body.innerHTML = "";
    const header = document.createElement("header");
    header.style.cssText =
      "position:sticky;top:0;height:40px;overflow:visible;background:#fff;z-index:2";
    const link = document.createElement("a");
    link.id = "hit";
    link.href = "#x";
    link.textContent = "Go";
    link.style.cssText = "display:inline-block;color:#111;background:#cfc";
    header.append(link);
    const buy = document.createElement("button");
    buy.id = "buy";
    buy.type = "button";
    buy.textContent = "Buy";
    buy.style.cssText = "display:block;width:64px;height:40px;margin:0;padding:0";
    document.body.append(header, buy);
    void document.body.offsetHeight;
    const applied = runtime.applyPatchSpec({
      id: "sticky-cover",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "hit" },
              declarations: [
                { property: "min-height", value: "64px" },
                { property: "min-width", value: "64px" },
              ],
            },
          ],
        },
      ],
    });
    const box = buy.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      ok: applied.ok,
      error: applied.error ?? "",
      css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ),
      hitId: hit instanceof Element ? hit.id : "",
    };
  });
  expect(result.ok, JSON.stringify(result)).toBe(false);
  expect(result.css).toBe(false);
  expect(result.hitId).toBe("buy");
});

test("R10 W2 Chromium capture click without preventDefault activates once", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "cap-once";
    host.style.cursor = "pointer";
    host.textContent = "Pay";
    document.body.append(host);
    let clicks = 0;
    host.addEventListener(
      "keydown",
      () => {
        host.click();
      },
      true,
    );
    host.addEventListener("click", () => {
      clicks += 1;
    });
    runtime.applyPatchSpec({
      id: "cap-once",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#cap-once", as: "button" }],
    });
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return clicks;
  });
  expect(result).toBe(1);
});

test("R10 W3 Chromium undoes aria-label after a label-in-name miss", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const pay = document.createElement("button");
    pay.type = "button";
    pay.id = "pay";
    pay.textContent = "Checkout";
    document.body.append(pay);
    const applied = runtime.applyPatchSpec({
      id: "aria-checkout",
      version: 0,
      ops: [{ op: "setAttribute", selector: "#pay", name: "aria-label", value: "Checkout" }],
    });
    pay.textContent = "Checkout (2)";
    await new Promise((resolve) => setTimeout(resolve, 80));
    return {
      ok: applied.ok,
      labelled: pay.hasAttribute("aria-label"),
    };
  });
  expect(result.ok).toBe(true);
  expect(result.labelled).toBe(false);
});

test("R10 W4 Chromium undoes overflow .item matches that fail contrast", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const list = document.createElement("div");
    list.style.cssText = "background-color:#fff;color:#111";
    for (let i = 0; i < 10; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "row";
      list.append(item);
    }
    document.body.append(list);
    const applied = runtime.applyPatchSpec({
      id: "items",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["item"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
    const dark = document.createElement("div");
    dark.style.cssText = "background-color:#111;color:#fff";
    for (let i = 0; i < 60; i += 1) {
      const item = document.createElement("span");
      item.className = "item";
      item.textContent = "ghost";
      dark.append(item);
    }
    document.body.append(dark);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: applied.ok, css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ) };
  });
  expect(result.ok).toBe(true);
  expect(result.css).toBe(false);
});

test("R9 I1 Chromium allows min-height on a link in a sticky header", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const header = document.createElement("div");
    header.style.cssText =
      "position:sticky;top:0;height:80px;background-color:#fff;display:flex;align-items:center";
    const link = document.createElement("a");
    link.id = "hit";
    link.href = "#x";
    link.textContent = "Go";
    link.style.cssText = "color:#111;background-color:#fff;min-height:44px;display:inline-flex;align-items:center";
    header.append(link);
    document.body.prepend(header);
    return runtime.applyPatchSpec({
      id: "sticky-hit",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "hit" },
              declarations: [{ property: "min-height", value: "44px" }],
            },
          ],
        },
      ],
    });
  });
  expect(result.ok, result.error).toBe(true);
});

test("R9 W4 Chromium color fix survives a dropdown overlay", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const nav = document.createElement("div");
    nav.className = "nav";
    nav.style.cssText = "position:relative;background:#fff;color:#111";
    nav.textContent = "Shop";
    const buy = document.createElement("button");
    buy.type = "button";
    buy.textContent = "Buy";
    document.body.append(nav, buy);
    const applied = runtime.applyPatchSpec({
      id: "nav-color",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["nav"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    });
    const menu = document.createElement("div");
    menu.style.cssText =
      "position:absolute;top:0;left:0;width:240px;height:120px;background:#111;color:#fff;z-index:9";
    menu.textContent = "Checkout";
    nav.append(menu);
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { ok: applied.ok, css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ) };
  });
  expect(result.ok).toBe(true);
  expect(result.css).toBe(true);
});

test("R11 Chromium page #eee on white does not undo a min-width spec", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      getRuntimeStats: () => { undos: number; attributions: number };
    };
    const hit = document.createElement("a");
    hit.id = "hit";
    hit.href = "#x";
    hit.textContent = "Go";
    hit.style.cssText = "color:#111;background:#fff";
    document.body.append(hit);
    runtime.applyPatchSpec({
      id: "minw",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "hit" },
              declarations: [{ property: "min-width", value: "44px" }],
            },
          ],
        },
      ],
    });
    const before = runtime.getRuntimeStats();
    hit.style.color = "#eee";
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = runtime.getRuntimeStats();
    return {
      css: [...document.querySelectorAll("[data-lift-css]")].some(
            (el) => el instanceof HTMLStyleElement && !el.disabled,
          ),
      undos: after.undos - before.undos,
      attributions: after.attributions - before.attributions,
    };
  });
  expect(result.css).toBe(true);
  expect(result.undos).toBe(0);
  expect(result.attributions).toBeLessThanOrEqual(1);
});

test("R11 Chromium window capture before promote activates once on Enter and Space", async ({
  page,
}) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const host = document.createElement("div");
    host.id = "pre-win";
    host.style.cursor = "pointer";
    host.textContent = "Pay";
    document.body.append(host);
    let clicks = 0;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.target === host) host.click();
      },
      true,
    );
    host.addEventListener("click", () => {
      clicks += 1;
    });
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    runtime.applyPatchSpec({
      id: "pre-win",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#pre-win", as: "button" }],
    });
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    host.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const enter = clicks;
    clicks = 0;
    host.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    host.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { enter, space: clicks };
  });
  expect(result.enter).toBe(1);
  expect(result.space).toBe(1);
});

test("R11 Chromium allows 44×44 on a sticky host itself", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
    };
    const hit = document.createElement("a");
    hit.id = "sticky-host";
    hit.href = "#x";
    hit.textContent = "Go";
    hit.style.cssText =
      "position:sticky;top:0;display:inline-block;color:#111;background:#fff";
    document.body.prepend(hit);
    return runtime.applyPatchSpec({
      id: "sticky-host-44",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "sticky-host" },
              declarations: [
                { property: "min-height", value: "44px" },
                { property: "min-width", value: "44px" },
              ],
            },
          ],
        },
      ],
    });
  });
  expect(result.ok, result.error).toBe(true);
});

test("R12 P2a Chromium per-node attribution undoes when B is spec-caused", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      getRuntimeStats: () => {
        lastAttributions: { id: string; verdict: string; predicate: string }[];
      };
    };
    const pageStyle = document.createElement("style");
    pageStyle.textContent = ".dark { background-color:#111; color:#fff }";
    document.head.append(pageStyle);
    const a = document.createElement("span");
    a.id = "node-a";
    a.className = "probe";
    a.textContent = "A page";
    a.style.cssText = "display:block;background-color:#fff;color:#111";
    const dark = document.createElement("div");
    dark.className = "dark";
    const b = document.createElement("span");
    b.id = "node-b";
    b.className = "probe";
    b.textContent = "B spec";
    b.style.cssText = "background-color:#fff;color:#111";
    document.body.append(a, dark, b);
    const applied = runtime.applyPatchSpec({
      id: "p2a",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["probe"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
    a.style.color = "#eee";
    b.style.backgroundColor = "";
    b.style.color = "";
    dark.append(b);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sheet = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    const bColor = getComputedStyle(b).color;
    const last = runtime.getRuntimeStats().lastAttributions;
    return {
      ok: applied.ok,
      disabled: Boolean(sheet?.disabled),
      bColor,
      last,
    };
  });
  expect(result.ok).toBe(true);
  expect(result.disabled).toBe(true);
  expect(result.bColor).not.toBe("rgb(17, 17, 17)");
  expect(result.last.some((row) => row.id === "node-a" && row.verdict === "page")).toBe(true);
  expect(result.last.some((row) => row.id === "node-b" && row.verdict === "spec")).toBe(true);
});

test("R12 P2b Chromium wrapper class swap invalidates a page verdict", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const pageStyle = document.createElement("style");
    pageStyle.textContent =
      ".ok { background-color:#fff } .bad .probe { color:#eee } .dark { background-color:#111; color:#fff }";
    document.head.append(pageStyle);
    const wrap = document.createElement("div");
    wrap.id = "wrap";
    wrap.className = "ok";
    const probe = document.createElement("span");
    probe.className = "probe";
    probe.textContent = "X";
    wrap.append(probe);
    document.body.append(wrap);
    const applied = runtime.applyPatchSpec({
      id: "p2b",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["probe"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
    wrap.className = "bad";
    await new Promise((resolve) => setTimeout(resolve, 120));
    wrap.className = "dark";
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sheet = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    return { ok: applied.ok, disabled: Boolean(sheet?.disabled) };
  });
  expect(result.ok).toBe(true);
  expect(result.disabled).toBe(true);
});

test("R12 P3a Chromium cssRules style edits are detected within 5s", async ({ page }) => {
  test.setTimeout(20_000);
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const probe = document.createElement("span");
    probe.className = "probe";
    probe.textContent = "Hi";
    probe.style.cssText = "background-color:#fff";
    document.body.append(probe);
    const applied = runtime.applyPatchSpec({
      id: "p3a",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["probe"] },
              declarations: [{ property: "color", value: "#111" }],
            },
          ],
        },
      ],
    });
    const sheet = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    const rule = sheet?.sheet?.cssRules?.[0] as CSSStyleRule | undefined;
    if (rule) rule.style.color = "#eee";
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (sheet?.disabled) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { ok: applied.ok, disabled: Boolean(sheet?.disabled), waited: Date.now() - started };
  });
  expect(result.ok).toBe(true);
  expect(result.disabled).toBe(true);
  expect(result.waited).toBeLessThan(5000);
});

test("R12 P3b Chromium adoptedStyleSheets replaceSync is detected within 5s", async ({ page }) => {
  test.setTimeout(20_000);
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      getRuntimeStats: () => { ticksRan: number; attributions: number };
    };
    const probe = document.createElement("span");
    probe.className = "probe";
    probe.textContent = "Hi";
    probe.style.cssText = "background-color:#fff";
    document.body.append(probe);
    runtime.applyPatchSpec({
      id: "p3b",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["probe"] },
              declarations: [{ property: "min-width", value: "44px" }],
            },
          ],
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const start = runtime.getRuntimeStats();
    const adopted = new CSSStyleSheet();
    adopted.replaceSync(".probe { color: #eee }");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];
    const started = Date.now();
    let sawTick = false;
    while (Date.now() - started < 5000) {
      const stats = runtime.getRuntimeStats();
      if (stats.ticksRan - start.ticksRan > 0 || stats.attributions - start.attributions > 0) {
        sawTick = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { sawTick, waited: Date.now() - started };
  });
  expect(result.sawTick).toBe(true);
  expect(result.waited).toBeLessThan(5000);
});

test("R12 P4a-e Chromium Enter/Space stay at one click", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const makeHost = (id: string) => {
      const host = document.createElement("div");
      host.id = id;
      host.style.cursor = "pointer";
      host.textContent = "Pay";
      document.body.append(host);
      return host;
    };
    const p4a = makeHost("p4a");
    let a = 0;
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.target === p4a) p4a.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      },
      true,
    );
    p4a.addEventListener("click", () => {
      a += 1;
    });
    runtime.applyPatchSpec({
      id: "p4a",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#p4a", as: "button" }],
    });
    p4a.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();

    const p4b = makeHost("p4b");
    let b = 0;
    p4b.addEventListener("click", () => {
      b += 1;
    });
    runtime.applyPatchSpec({
      id: "p4b",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#p4b", as: "button" }],
    });
    p4b.addEventListener("keydown", () => {
      p4b.click();
    });
    p4b.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();

    const p4d = makeHost("p4d");
    let d = 0;
    p4d.addEventListener("click", () => {
      d += 1;
    });
    runtime.applyPatchSpec({
      id: "p4d",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#p4d", as: "button" }],
    });
    p4d.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    p4d.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true, cancelable: true }));
    await flush();

    const p4e = makeHost("p4e");
    let e = 0;
    p4e.addEventListener("click", () => {
      e += 1;
    });
    runtime.applyPatchSpec({
      id: "p4e",
      version: 0,
      ops: [{ op: "bindEnterToClick", selector: "#p4e" }],
    });
    p4e.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();

    return { a, b, d, e };
  });
  expect(result.a).toBe(1);
  expect(result.b).toBe(1);
  expect(result.d).toBe(1);
  expect(result.e).toBe(1);
});

test("R12 W5 Chromium attribution keeps focus, disclosure, and scroll", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      getRuntimeStats: () => { attributions: number; undos: number };
    };
    const spacer = document.createElement("div");
    spacer.style.height = "2000px";
    const host = document.createElement("div");
    host.id = "focus-keep";
    host.style.cssText =
      "cursor:pointer;color:#111;background:#fff;padding:12px;outline:3px solid #38bdf8";
    host.textContent = "Pay now";
    const tr = document.createElement("button");
    tr.id = "tr";
    tr.type = "button";
    tr.textContent = "More";
    const panel = document.createElement("div");
    panel.id = "panel";
    panel.textContent = "Hidden";
    document.body.append(spacer, host, tr, panel);
    runtime.applyPatchSpec({
      id: "w5",
      version: 0,
      ops: [
        { op: "promoteToControl", selector: "#focus-keep", as: "button" },
        { op: "toggleDisclosure", trigger: "#tr", panel: "#panel" },
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "focus-keep" },
              declarations: [{ property: "min-width", value: "44px" }],
            },
          ],
        },
      ],
    });
    host.focus({ preventScroll: true });
    tr.click();
    const before = runtime.getRuntimeStats();
    host.style.color = "#eee";
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = runtime.getRuntimeStats();
    return {
      focused: document.activeElement === host,
      open: panel.classList.contains("lift-open"),
      attributions: after.attributions - before.attributions,
      undos: after.undos - before.undos,
      css: [...document.querySelectorAll("[data-lift-css]")].some(
        (el) => el instanceof HTMLStyleElement && !el.disabled,
      ),
    };
  });
  expect(result.focused).toBe(true);
  expect(result.open).toBe(true);
  expect(result.attributions).toBeGreaterThanOrEqual(1);
  expect(result.undos).toBe(0);
  expect(result.css).toBe(true);
});

test("R13 real Enter with a document keydown click fires once", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "r13-enter";
    host.style.cssText = "cursor:pointer;padding:12px";
    host.textContent = "Pay";
    document.body.append(host);
    (window as unknown as { __r13Clicks: number }).__r13Clicks = 0;
    document.addEventListener("keydown", (event) => {
      const t = event.target;
      if (t instanceof HTMLElement && t.id === "r13-enter") t.click();
    });
    host.addEventListener("click", () => {
      (window as unknown as { __r13Clicks: number }).__r13Clicks += 1;
    });
    runtime.applyPatchSpec({
      id: "r13-enter",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#r13-enter", as: "button" }],
    });
  });
  await page.locator("#r13-enter").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as unknown as { __r13Clicks: number }).__r13Clicks)).toBe(
    1,
  );
});

test("R13 real Enter still fires after Shift+click", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "r13-shift";
    host.style.cssText = "cursor:pointer;padding:12px";
    host.textContent = "Pay";
    document.body.append(host);
    (window as unknown as { __r13Shift: number }).__r13Shift = 0;
    host.addEventListener("click", () => {
      (window as unknown as { __r13Shift: number }).__r13Shift += 1;
    });
    runtime.applyPatchSpec({
      id: "r13-shift",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#r13-shift", as: "button" }],
    });
  });
  await page.locator("#r13-shift").click({ modifiers: ["Shift"] });
  const afterShift = await page.evaluate(
    () => (window as unknown as { __r13Shift: number }).__r13Shift,
  );
  expect(afterShift).toBe(1);
  await page.locator("#r13-shift").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as unknown as { __r13Shift: number }).__r13Shift)).toBe(
    2,
  );
});

test("R13 smooth scrollTo is not snapped back by attribution", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const spacer = document.createElement("div");
    spacer.style.height = "6000px";
    const host = document.createElement("a");
    host.id = "r13-smooth";
    host.href = "#x";
    host.textContent = "Go";
    host.style.cssText = "color:#111;background:#fff";
    document.body.append(spacer, host);
    runtime.applyPatchSpec({
      id: "r13-smooth",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "r13-smooth" },
              declarations: [{ property: "min-width", value: "44px" }],
            },
          ],
        },
      ],
    });
  });
  await page.evaluate(() => window.scrollTo({ top: 4000, behavior: "smooth" }));
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const host = document.getElementById("r13-smooth");
    if (host instanceof HTMLElement) host.style.color = "#eee";
  });
  await page.waitForTimeout(200);
  const y = await page.evaluate(() => window.scrollY);
  expect(y).toBeGreaterThan(1500);
});

test("R17 off-viewport lost-hit-target recheck undoes instead of treating unknown as persist", async ({
  page,
}) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean; error?: string };
      setTestBackstopsPaused: (paused: boolean) => boolean;
      getRuntimeStats: () => { undos: number };
    };
    document.querySelector(".sim-banner")?.remove();
    document.querySelector("header")?.remove();
    document.querySelector(".product")?.remove();
    const wrap = document.createElement("div");
    wrap.id = "off-hit-wrap";
    for (let i = 0; i < 8; i += 1) {
      const a = document.createElement("a");
      a.className = "off-hit";
      a.id = `off-hit-${i}`;
      a.href = `#x${i}`;
      a.textContent = `Go ${i + 1}`;
      a.style.cssText = "display:block;color:#111;background:#fff;font:10px/1 sans-serif";
      wrap.append(a);
    }
    document.body.prepend(wrap);
    const tail = document.createElement("div");
    tail.style.height = "2400px";
    document.body.append(tail);
    const applied = runtime.applyPatchSpec({
      id: "off-hit",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["off-hit"] },
              declarations: [{ property: "min-height", value: "44px" }],
            },
          ],
        },
      ],
    });
    const target = document.getElementById("off-hit-5");
    if (target) {
      const y = target.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, Math.max(0, y - 8));
    }
    const grown = target?.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.id = "off-hit-cover";
    overlay.style.cssText = grown
      ? `position:fixed;left:${grown.left}px;top:${grown.top}px;width:${grown.width}px;height:${grown.height}px;z-index:9;background:rgba(0,0,0,.35)`
      : "position:fixed;left:0;top:0;width:40px;height:40px;z-index:9";
    document.body.append(overlay);
    const before = runtime.getRuntimeStats().undos;
    await new Promise((resolve) => setTimeout(resolve, 200));
    runtime.setTestBackstopsPaused(true);
    runtime.setTestBackstopsPaused(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sheet = document.querySelector("[data-lift-css]") as HTMLStyleElement | null;
    return {
      ok: applied.ok,
      error: applied.error ?? "",
      disabled: Boolean(sheet?.disabled),
      undos: runtime.getRuntimeStats().undos - before,
    };
  });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, disabled: true });
  expect(result.undos).toBeGreaterThanOrEqual(1);
});

test("R13 mouse wheel is not snapped back by attribution", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const spacer = document.createElement("div");
    spacer.style.height = "6000px";
    const host = document.createElement("a");
    host.id = "r13-wheel";
    host.href = "#x";
    host.textContent = "Go";
    host.style.cssText = "color:#111;background:#fff";
    document.body.append(spacer, host);
    runtime.applyPatchSpec({
      id: "r13-wheel",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { id: "r13-wheel" },
              declarations: [{ property: "min-width", value: "44px" }],
            },
          ],
        },
      ],
    });
  });
  await page.evaluate(() => window.scrollTo(0, 3000));
  await page.mouse.move(400, 300);
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(80);
  const before = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => {
    const host = document.getElementById("r13-wheel");
    if (host instanceof HTMLElement) host.style.color = "#eee";
  });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => window.scrollY);
  expect(Math.abs(after - before)).toBeLessThan(80);
  expect(after).toBeGreaterThan(1500);
});

test("R14 real Enter then a timer host.click then Enter is three clicks", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "r14-timer";
    host.style.cssText = "cursor:pointer;padding:12px";
    host.textContent = "Pay";
    document.body.append(host);
    (window as unknown as { __r14Clicks: number }).__r14Clicks = 0;
    host.addEventListener("click", () => {
      (window as unknown as { __r14Clicks: number }).__r14Clicks += 1;
    });
    runtime.applyPatchSpec({
      id: "r14-timer",
      version: 0,
      ops: [{ op: "promoteToControl", selector: "#r14-timer", as: "button" }],
    });
  });
  const host = page.locator("#r14-timer");
  await host.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const el = document.getElementById("r14-timer");
    window.setTimeout(() => {
      if (el instanceof HTMLElement) el.click();
    }, 20);
  });
  await page.waitForTimeout(80);
  await host.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => (window as unknown as { __r14Clicks: number }).__r14Clicks)).toBe(
    3,
  );
});

test("R14 smooth scroll to top is not cancelled by colour-fight attribution", async ({ page }) => {
  test.setTimeout(20_000);
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const startUndos = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      getRuntimeStats: () => { undos: number };
    };
    const wrap = document.createElement("div");
    wrap.id = "r14-smooth";
    for (let i = 0; i < 45; i += 1) {
      const a = document.createElement("a");
      a.className = "r14-link";
      a.href = `#x${i}`;
      a.textContent = `Link ${i + 1}`;
      a.style.cssText = "display:block;color:#111;background:#fff";
      wrap.append(a);
    }
    document.body.append(wrap);
    document.documentElement.style.scrollBehavior = "smooth";
    runtime.applyPatchSpec({
      id: "r14-smooth",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["r14-link"] },
              declarations: [{ property: "min-height", value: "44px" }],
            },
          ],
        },
      ],
    });
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
    return runtime.getRuntimeStats().undos;
  });
  await page.waitForTimeout(80);
  const bottom = await page.evaluate(() => window.scrollY);
  expect(bottom).toBeGreaterThan(400);
  await page.evaluate(() => {
    let on = false;
    window.setInterval(() => {
      on = !on;
      for (const el of document.querySelectorAll(".r14-link")) {
        if (el instanceof HTMLElement) el.style.color = on ? "#eee" : "#111";
      }
    }, 30);
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(() => window.scrollY === 0, null, { timeout: 8000 });
  const after = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      getRuntimeStats: () => { undos: number };
    };
    const link = document.querySelector(".r14-link");
    return {
      y: window.scrollY,
      undos: runtime.getRuntimeStats().undos,
      minHeight: link ? getComputedStyle(link).minHeight : "",
      hasSheet: Boolean(document.querySelector("[data-lift-css]")),
    };
  });
  expect(after.y).toBe(0);
  expect(after.undos - startUndos).toBe(0);
  expect(after.minHeight).toBe("44px");
  expect(after.hasSheet).toBe(true);
});

test("GET // returns 400 and the site still serves", async ({ request }) => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: SITE_PORT, path: "//", method: "GET" },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
  expect(status).toBe(400);
  const ok = await request.get("/checkout/");
  expect(ok.status()).toBe(200);
});
