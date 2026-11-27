import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";
import {
  AXE_GATE_RULES,
  PATCH_OPS,
  parsePatchSpec,
} from "../../shared/patch-spec.ts";

function loadCheckoutTreatment(): unknown {
  return JSON.parse(readFileSync(resolve(ROOT, "runtime/checkout-treatment.json"), "utf8"));
}

describe("parsePatchSpec", () => {
  it("accepts the checkout treatment spec", () => {
    const parsed = parsePatchSpec(loadCheckoutTreatment());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.spec.id).toBe("checkout-treatment-v0");
    expect(parsed.spec.version).toBe(0);
    expect(parsed.spec.ops.map((op) => op.op)).toEqual([
      "injectCSS",
      "promoteToControl",
      "setAttribute",
      "toggleDisclosure",
      "setAttribute",
      "wrapLabel",
      "wrapLabel",
      "wrapLabel",
      "wrapLabel",
      "wrapLabel",
      "wrapLabel",
      "setText",
      "promoteToControl",
    ]);
  });

  it("rejects unknown versions, unknown ops, and event-handler attributes", () => {
    expect(parsePatchSpec({ id: "x", version: 1, ops: [] }).ok).toBe(false);
    expect(parsePatchSpec({ id: "x", version: 0, ops: [{ op: "eval", selector: "body" }] }).ok).toBe(
      false,
    );
    expect(
      parsePatchSpec({
        id: "x",
        version: 0,
        ops: [{ op: "setAttribute", selector: "a", name: "onclick", value: "alert(1)" }],
      }).ok,
    ).toBe(false);
    expect(
      parsePatchSpec({
        id: "x",
        version: 0,
        ops: [{ op: "insertHTML", selector: "body", position: "append", html: "<script>x</script>" }],
      }).ok,
    ).toBe(false);
    const replaced = parsePatchSpec({
      id: "x",
      version: 0,
      ops: [{ op: "replaceTag", selector: "#x", tag: "script" }],
    });
    expect(replaced.ok).toBe(false);
    if (!replaced.ok) expect(replaced.error).toContain("promoteToControl");
  });

  it("accepts every declared op with a minimal valid payload", () => {
    const samples: Record<(typeof PATCH_OPS)[number], object> = {
      setAttribute: { op: "setAttribute", selector: "#x", name: "aria-label", value: "Go" },
      setText: { op: "setText", selector: "#x", text: "Go" },
      injectCSS: {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
      wrapLabel: { op: "wrapLabel", selector: "#email", text: "Email" },
      makeFocusable: { op: "makeFocusable", selector: "#x" },
      bindEnterToClick: { op: "bindEnterToClick", selector: "#x" },
      promoteToControl: {
        op: "promoteToControl",
        selector: "#x",
        as: "button",
      },
      insertHTML: {
        op: "insertHTML",
        selector: "main",
        position: "prepend",
        html: "<span>Skip</span>",
        mountId: "skip",
      },
      toggleDisclosure: { op: "toggleDisclosure", trigger: "#shop-trigger", panel: "#shop-menu" },
    };
    for (const op of PATCH_OPS) {
      const parsed = parsePatchSpec({ id: `op-${op}`, version: 0, ops: [samples[op]] });
      expect(parsed.ok, op).toBe(true);
    }
  });
});

describe("axe gate rules", () => {
  it("lists the rules no variant may skip", () => {
    expect([...AXE_GATE_RULES]).toEqual(["label", "button-name", "color-contrast"]);
  });
});
