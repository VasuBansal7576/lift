import { describe, expect, it } from "vitest";
import {
  setEnvironmentDefault,
  type EnvironmentDefaultClient,
} from "../../agent/src/decide.ts";
import { FlagsmithAdminError } from "../../agent/src/flagsmith-admin.ts";

function error(status: number, body = "no"): FlagsmithAdminError {
  return new FlagsmithAdminError(`PATCH failed ${status}: ${body}`, status, body);
}

describe("setEnvironmentDefault", () => {
  it("uses v2 unicode when the future endpoint accepts it", async () => {
    const calls: string[] = [];
    const admin = {
      patchFutureFeature: async (_env: string, _id: number, body: unknown) => {
        calls.push(`v2:${JSON.stringify(body)}`);
        return { status: 200, data: {} };
      },
      get: async () => {
        throw new Error("v1 GET should not run");
      },
      patch: async () => {
        throw new Error("v1 PATCH should not run");
      },
    } as unknown as EnvironmentDefaultClient;
    const path = await setEnvironmentDefault(admin, "env", 10, 99, "treatment");
    expect(path).toBe("v2_unicode");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/"type":"unicode"/);
  });

  it("retries v2 with string after unicode 400", async () => {
    const types: string[] = [];
    const admin = {
      patchFutureFeature: async (_env: string, _id: number, body: unknown) => {
        const typed = body as { environment_default: { value: { type: string } } };
        types.push(typed.environment_default.value.type);
        if (typed.environment_default.value.type === "unicode") {
          throw error(400, "invalid type");
        }
        return { status: 200, data: {} };
      },
      get: async () => {
        throw new Error("v1 GET should not run");
      },
      patch: async () => {
        throw new Error("v1 PATCH should not run");
      },
    } as unknown as EnvironmentDefaultClient;
    const path = await setEnvironmentDefault(admin, "env", 10, 99, "control");
    expect(path).toBe("v2_string");
    expect(types).toEqual(["unicode", "string"]);
  });

  it("falls back to v1 featurestates after both v2 types fail", async () => {
    const admin = {
      patchFutureFeature: async () => {
        throw error(400, "This environment uses v2 feature versioning");
      },
      get: async (url: string) => {
        expect(url).toContain("/featurestates/?feature=10");
        return {
          status: 200,
          data: {
            results: [
              {
                id: 77,
                multivariate_feature_state_values: [
                  { id: 1, multivariate_feature_option: 99, percentage_allocation: 50 },
                ],
              },
            ],
          },
        };
      },
      patch: async (url: string, body: unknown) => {
        expect(url).toBe("/features/featurestates/77/");
        expect(body).toMatchObject({
          enabled: true,
          feature_state_value: "treatment",
          multivariate_feature_state_values: [
            { id: 1, multivariate_feature_option: 99, percentage_allocation: 100 },
          ],
        });
        return { status: 200, data: {} };
      },
    } as unknown as EnvironmentDefaultClient;
    const path = await setEnvironmentDefault(admin, "env", 10, 99, "treatment");
    expect(path).toBe("v1_featurestates");
  });
});
