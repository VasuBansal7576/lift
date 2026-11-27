import http from "node:http";
import { expect, test } from "@playwright/test";
import { CSS_ATTACKS, INSERT_HTML_ATTACKS } from "../fixtures/patch-spec-corpus.ts";

test("Chromium rejects the CSS attack corpus through runtime.js", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const results = await page.evaluate(async (attacks) => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      isSafeCss: (css: string) => boolean;
      parsePatchSpec: (input: unknown) => { ok: boolean };
    };
    return attacks.map((attack) => ({
      name: attack.name,
      safe: runtime.isSafeCss(attack.css),
      parsed: runtime.parsePatchSpec({
        id: "atk",
        version: 0,
        ops: [{ op: "injectCSS", css: attack.css }],
      }).ok,
    }));
  }, CSS_ATTACKS);
  for (const result of results) {
    expect(result.safe, result.name).toBe(false);
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
    runtime.applyPatchSpec({
      id: "css",
      version: 0,
      ops: [{ op: "injectCSS", id: "s1", css: ".x { color: #111; }" }],
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

test("setText rollback restores child elements", async ({ page }) => {
  await page.goto("/checkout/?lift_variant=control");
  const result = await page.evaluate(async () => {
    const href = new URL("/runtime/runtime.js", location.origin).href;
    const runtime = (await import(href)) as {
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    document.body.insertAdjacentHTML("beforeend", `<p id="keep"><span id="kid">a</span>b</p>`);
    const applied = runtime.applyPatchSpec({
      id: "settext-undo",
      version: 0,
      ops: [
        { op: "setText", selector: "#keep", text: "new" },
        { op: "setText", selector: "#missing", text: "nope" },
      ],
    });
    return {
      ok: applied.ok,
      kid: document.getElementById("kid")?.textContent ?? null,
      text: document.getElementById("keep")?.textContent ?? null,
    };
  });
  expect(result.ok).toBe(false);
  expect(result.kid).toBe("a");
  expect(result.text).toBe("ab");
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
      ops: [{ op: "replaceTag", selector: "#chain-pay", tag: "button", attributes: { type: "button" } }],
    });
    runtime.applyPatchSpec({
      id: "chain-2",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#chain-pay", tag: "a", attributes: { href: "#ok" } }],
    });
    document.getElementById("chain-pay")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return { n, tag: document.getElementById("chain-pay")?.tagName ?? "" };
  });
  expect(clicks.tag).toBe("A");
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
          attributes: { class: "lift-btn-test" },
        },
      ],
    };
    const first = runtime.applyPatchSpec(spec);
    const second = runtime.applyPatchSpec(spec);
    return {
      first: first.ok,
      second: second.ok,
      buttons: document.querySelectorAll("button.lift-btn-test").length,
      chips: document.querySelectorAll(".lift-chip-test").length,
    };
  });
  expect(result.first).toBe(true);
  expect(result.second).toBe(true);
  expect(result.buttons).toBe(1);
  expect(result.chips).toBe(0);
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
    runtime.applyPatchSpec({
      id: "css-1",
      version: 0,
      ops: [{ op: "injectCSS", id: "s1", css: ".a { color: #111; }" }],
    });
    const afterFirst = document.getElementById("lift-patch-css-s1")?.textContent ?? "";
    runtime.applyPatchSpec({
      id: "css-2",
      version: 0,
      ops: [{ op: "injectCSS", id: "s1", css: ".a { color: #222; }" }],
    });
    const afterSecond = document.getElementById("lift-patch-css-s1")?.textContent ?? "";
    const rolled = runtime.applyPatchSpec({
      id: "css-3",
      version: 0,
      ops: [
        { op: "injectCSS", id: "s1", css: ".a { color: #333; }" },
        { op: "setText", selector: "#missing", text: "nope" },
      ],
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
      isSafeCss: (css: string) => boolean;
      applyPatchSpec: (input: unknown) => { ok: boolean };
    };
    const smuggle = 'h1{color:"/*"; background-image:url(http://x/leak) /* */}';
    const isBody = ":is(body){opacity:0}";
    const before = document.body.style.opacity;
    const applied = runtime.applyPatchSpec({
      id: "evil",
      version: 0,
      ops: [{ op: "injectCSS", css: isBody }],
    });
    return {
      smuggleSafe: runtime.isSafeCss(smuggle),
      isBodySafe: runtime.isSafeCss(isBody),
      appliedOk: applied.ok,
      opacity: document.body.style.opacity,
      before,
    };
  });
  expect(result.smuggleSafe).toBe(false);
  expect(result.isBodySafe).toBe(false);
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
        { op: "replaceTag", selector: "#lift-enter-once", tag: "span" },
        { op: "makeFocusable", selector: "#lift-enter-once" },
        { op: "bindEnterToClick", selector: "#lift-enter-once" },
      ],
    });
    document
      .getElementById("lift-enter-once")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return { clicks, keys, tag: document.getElementById("lift-enter-once")?.tagName ?? "" };
  });
  expect(counts.tag).toBe("SPAN");
  expect(counts.clicks).toBe(1);
  expect(counts.keys).toBe(0);
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
