/** @vitest-environment happy-dom */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../agent/src/config.ts";
import { parsePatchSpec } from "../../shared/patch-spec.ts";
import { PATCH_SPEC_CORPUS } from "../fixtures/patch-spec-corpus.ts";
import { validatePatchSpec } from "../../runtime/runtime.js";

const schema = JSON.parse(
  readFileSync(resolve(ROOT, "shared/patch-spec.schema.json"), "utf8"),
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateSchema = ajv.compile(schema);

describe("parsePatchSpec (TS) and validatePatchSpec (JS) agree", () => {
  for (const fixture of PATCH_SPEC_CORPUS) {
    it(fixture.name, () => {
      const ts = parsePatchSpec(fixture.spec);
      const js = validatePatchSpec(fixture.spec);
      expect(ts.ok, "ts.ok").toBe(fixture.ok);
      expect(js.ok, "js.ok").toBe(fixture.ok);
      expect(js.ok, "parsers disagree on ok").toBe(ts.ok);
      if (!fixture.ok) {
        expect(ts).toEqual({ ok: false, error: fixture.error });
        expect(js).toEqual({ ok: false, error: fixture.error });
      }
      if (fixture.schema !== "skip") {
        const schemaOk = fixture.schema ?? fixture.ok;
        expect(validateSchema(fixture.spec), JSON.stringify(validateSchema.errors)).toBe(schemaOk);
      }
    });
  }

  it("checkout treatment spec is valid in both parsers and the schema", () => {
    const spec = JSON.parse(
      readFileSync(resolve(ROOT, "runtime/checkout-treatment.json"), "utf8"),
    ) as unknown;
    const ts = parsePatchSpec(spec);
    const js = validatePatchSpec(spec);
    expect(ts.ok).toBe(true);
    expect(js.ok).toBe(true);
    expect(validateSchema(spec)).toBe(true);
  });
});
