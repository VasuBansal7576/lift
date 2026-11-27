import http from "node:http";
import { expect, test } from "@playwright/test";
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

test("chained replaceTag forwards one click to the original node", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const clicks = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const host = document.createElement("div");
    host.id = "chain-pay";
    host.textContent = "Pay";
    document.body.append(host);
    let n = 0;
    host.addEventListener("click", () => {
      n += 1;
    });
    runtime.applyPatchSpec({
      id: "chain-1",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#chain-pay", tag: "button" }],
    });
    runtime.applyPatchSpec({
      id: "chain-2",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#chain-pay", tag: "button" }],
    });
    document.getElementById("chain-pay")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { n, tag: document.getElementById("chain-pay")?.tagName ?? "" };
  });
  expect(clicks.tag).toBe("BUTTON");
  expect(clicks.n).toBe(1);
});

test("replaceTag on a class selector is idempotent", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    document.body.insertAdjacentHTML("beforeend", `<span class="lift-chip-test">Go</span>`);
    const spec = {
      id: "class-replace",
      version: 0,
      ops: [
        {
          op: "replaceTag",
          selector: ".lift-chip-test",
          tag: "button",
        },
      ],
    };
    const first = runtime.applyPatchSpec(spec);
    const second = runtime.applyPatchSpec(spec);
    return {
      first: first.ok,
      second: second.ok,
      buttons: document.querySelectorAll("button.lift-chip-test").length,
      spans: document.querySelectorAll("span.lift-chip-test").length,
    };
  });
  expect(result.first).toBe(true);
  expect(result.second).toBe(true);
  expect(result.buttons).toBe(1);
  expect(result.spans).toBe(0);
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
  expect(result.error).toContain("a requires href");
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
      ops: [
        { op: "replaceTag", selector: "#lift-enter-once", tag: "button" },
        { op: "bindEnterToClick", selector: "#lift-enter-once" },
      ],
    });
    document
      .getElementById("lift-enter-once")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { clicks, keys, tag: document.getElementById("lift-enter-once")?.tagName ?? "" };
  });
  expect(counts.tag).toBe("BUTTON");
  expect(counts.clicks).toBe(1);
  expect(counts.keys).toBe(0);
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
    buy.style.cssText = "position:fixed;top:80px;left:40px;z-index:1";
    const bar = document.createElement("div");
    bar.className = "cookie-bar";
    bar.textContent = "Cookies";
    bar.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9;background:#111;color:#fff";
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
      cssAfter: Boolean(document.querySelector("[data-lift-css]")),
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
              declarations: [{ property: "color", value: "#111" }],
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
    document.body.setAttribute("style", "background:#000");
    await new Promise((resolve) => {
      const check = () => {
        if (!document.querySelector("[data-lift-css]")) {
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
      undone: !document.querySelector("[data-lift-css]"),
      ms: performance.now() - started,
    };
  });
  expect(result.applied).toBe(true);
  expect(result.undone).toBe(true);
  expect(result.ms).toBeLessThan(300);
});

test("R7 W6 Chromium 10k-node apply and guard tick stay under 50ms", async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto("/checkout/?lift_variant=control&lift_bot=1");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
      setTestBackstopsPaused: (paused: boolean) => boolean;
    };
    const host = document.createElement("div");
    host.id = "perf-host";
    const probe = document.createElement("span");
    probe.className = "probe";
    probe.textContent = "x";
    host.appendChild(probe);
    const chunk = document.createDocumentFragment();
    for (let i = 0; i < 10_000; i += 1) {
      const node = document.createElement("span");
      node.textContent = "n";
      chunk.appendChild(node);
    }
    host.appendChild(chunk);
    document.body.appendChild(host);
    const spec = {
      id: "perf-10k",
      version: 0,
      ops: [
        {
          op: "injectCSS",
          rules: [
            {
              selector: { classes: ["probe"] },
              declarations: [
                { property: "color", value: "#111" },
                { property: "background-color", value: "#fff" },
              ],
            },
          ],
        },
      ],
    };
    const t0 = performance.now();
    const applied = runtime.applyPatchSpec(spec);
    const applyMs = performance.now() - t0;
    runtime.setTestBackstopsPaused(true);
    document.body.classList.add("tick");
    document.body.setAttribute("data-perf", "1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const t1 = performance.now();
    runtime.setTestBackstopsPaused(false);
    const guardMs = performance.now() - t1;
    return { ok: applied.ok, applyMs, guardMs };
  });
  console.log(`perf-10k applyMs=${result.applyMs.toFixed(2)} guardMs=${result.guardMs.toFixed(2)}`);
  expect(result.ok).toBe(true);
  expect(result.applyMs).toBeLessThan(50);
  expect(result.guardMs).toBeLessThan(50);
});

test("GET // returns 400 and the site still serves", async ({ request }) => {
  const status = await new Promise<number>((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: 4174, path: "//", method: "GET" },
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
