import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePatchSpec, type PatchOp, type PatchSpec } from "../../../shared/patch-spec.ts";
import type { EventLog } from "../log.ts";
import { REPO_ROOT } from "../paths.ts";
import { stripSecretsFromText } from "../secrets.ts";
import type { AxeSummary, CandidateKind, CandidateSpec } from "../types.ts";

const FIELD_LABELS: Array<{ selector: string; text: string }> = [
  { selector: "#email", text: "Email" },
  { selector: "#card-name", text: "Name on card" },
  { selector: "#card-number", text: "Card number" },
  { selector: "#card-exp", text: "Expiry" },
  { selector: "#card-cvc", text: "CVC" },
  { selector: "#terms", text: "I agree to the terms of sale and understand this order is final." },
];

function spec(id: string, ops: PatchOp[]): PatchSpec {
  return { id, version: 0, ops };
}

export function labelsSpec(id = "labels-v1"): PatchSpec {
  return spec(
    id,
    FIELD_LABELS.map((field) => ({
      op: "wrapLabel" as const,
      selector: field.selector,
      text: field.text,
    })),
  );
}

export function contrastSpec(id = "contrast-v1"): PatchSpec {
  return spec(id, [
    {
      op: "injectCSS",
      id: `${id}-css`,
      rules: [
        {
          selector: { tag: "p", classes: ["terms", "contrast-fail"] },
          declarations: [
            { property: "color", value: "#111" },
            { property: "background-color", value: "#fff" },
          ],
        },
      ],
    },
  ]);
}

export function fullTreatmentSpec(id = "full-v1"): PatchSpec {
  const raw = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "runtime/checkout-treatment.json"), "utf8"),
  ) as PatchSpec;
  return { ...raw, id };
}

/**
 * Hostile canary the CSS allowlist and runtime accept: `#767676` on white
 * `.lede` (4.54:1, the parse floor) plus `role=checkbox` without `aria-checked`.
 * Axe then rejects with `added axe rules: aria-required-attr`.
 */
export function badContrastSpec(id = "bad-contrast-v1"): PatchSpec {
  return spec(id, [
    {
      op: "injectCSS",
      id: `${id}-css`,
      rules: [
        {
          selector: { tag: "p", classes: ["lede"] },
          declarations: [
            { property: "color", value: "#767676" },
            { property: "background-color", value: "#ffffff" },
            { property: "font-size", value: "12px" },
            { property: "letter-spacing", value: "0.2em" },
          ],
        },
      ],
    },
    {
      op: "setAttribute",
      selector: "p.lede",
      name: "role",
      value: "checkbox",
    },
  ]);
}

export function focusOutlineChallenger(base: PatchSpec, id: string): PatchSpec {
  return spec(id, [
    ...base.ops,
    {
      op: "injectCSS",
      id: `${id}-focus`,
      rules: [
        {
          selector: { id: "place-order", state: "focus-visible" },
          declarations: [
            { property: "outline-style", value: "solid" },
            { property: "outline-width", value: "2px" },
            { property: "outline-color", value: "#ffffff" },
            { property: "outline-offset", value: "1px" },
          ],
        },
      ],
    },
  ]);
}

export function typeScaleChallenger(base: PatchSpec, id: string): PatchSpec {
  return spec(id, [
    ...base.ops,
    {
      op: "injectCSS",
      id: `${id}-type`,
      rules: [
        {
          selector: { tag: "p", classes: ["terms", "contrast-fail"] },
          declarations: [{ property: "font-size", value: "18px" }],
        },
      ],
    },
  ]);
}

export function cursorChallenger(base: PatchSpec, id: string): PatchSpec {
  return spec(id, [
    ...base.ops,
    {
      op: "injectCSS",
      id: `${id}-cursor`,
      rules: [
        {
          selector: { id: "shop-trigger" },
          declarations: [{ property: "cursor", value: "pointer" }],
        },
      ],
    },
  ]);
}

function candidate(
  patch: PatchSpec,
  kind: CandidateKind,
  title: string,
  fromRules: string[],
): CandidateSpec {
  return { spec: patch, kind, title, fromRules };
}

export function templatesFromViolations(
  axe: AxeSummary,
  generation = 1,
  champion?: PatchSpec | null,
): CandidateSpec[] {
  const rules = new Set(axe.ruleIds);
  const out: CandidateSpec[] = [];

  if (generation >= 2 && champion) {
    out.push(
      candidate(
        focusOutlineChallenger(champion, `g${generation}-focus`),
        "generation-2",
        "Champion + focus-visible outline",
        ["focus-visible"],
      ),
    );
    out.push(
      candidate(
        typeScaleChallenger(champion, `g${generation}-type`),
        "generation-2",
        "Champion + terms type scale",
        ["font-size"],
      ),
    );
    out.push(
      candidate(
        cursorChallenger(champion, `g${generation}-cursor`),
        "generation-2",
        "Champion + shop cursor affordance",
        ["cursor"],
      ),
    );
    out.push(
      candidate(
        badContrastSpec(`g${generation}-bad-contrast`),
        "canary-reject",
        "Hostile near-threshold lede contrast (must reject via axe)",
        ["color-contrast"],
      ),
    );
    return out;
  }

  if (rules.has("label") || rules.has("label-title-only")) {
    out.push(candidate(labelsSpec(), "template", "Wrap visible labels on unlabeled fields", ["label"]));
  }
  if (rules.has("color-contrast")) {
    out.push(candidate(contrastSpec(), "template", "Raise terms contrast to 4.5:1+", ["color-contrast"]));
  }
  out.push(
    candidate(fullTreatmentSpec(), "template", "Combined checkout treatment spec", [
      "label",
      "button-name",
      "color-contrast",
    ]),
  );
  out.push(
    candidate(badContrastSpec(), "canary-reject", "Hostile near-threshold lede contrast (must reject via axe)", [
      "color-contrast",
    ]),
  );
  return out;
}

interface LlmClient {
  complete(prompt: string): Promise<string>;
}

async function groqComplete(prompt: string, key: string): Promise<string> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.LIFT_LLM_MODEL || "llama-3.1-8b-instant",
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

async function geminiComplete(prompt: string, key: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    },
  );
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

function extractSpec(text: string): PatchSpec | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = parsePatchSpec(JSON.parse(match[0]));
    return parsed.ok ? parsed.spec : null;
  } catch {
    return null;
  }
}

export async function maybeLlmCandidates(
  axe: AxeSummary,
  log: EventLog,
  client?: LlmClient,
): Promise<CandidateSpec[]> {
  const groq = process.env.GROQ_API_KEY?.trim();
  const gemini = process.env.GEMINI_API_KEY?.trim();
  const generic = process.env.LIFT_LLM_API_KEY?.trim();
  if (!client && !groq && !gemini && !generic) {
    log.emit("mutator", "info", "template mutator; LLM optional when a key is set");
    return [];
  }
  const prompt = `Return JSON only: a Lift PatchSpec (id, version: 0, ops) that fixes these axe violations without using injectCSS color equal to background: ${JSON.stringify(axe.violations.map((v) => v.id))}`;
  try {
    const text = client
      ? await client.complete(prompt)
      : groq
        ? await groqComplete(prompt, groq)
        : gemini
          ? await geminiComplete(prompt, gemini)
          : "";
    const parsed = extractSpec(text);
    if (!parsed) {
      log.emit("mutator", "warn", "LLM candidate ignored (invalid PatchSpec)");
      return [];
    }
    log.emit("mutator", "info", `LLM candidate ${parsed.id}`);
    return [candidate(parsed, "llm", `LLM ${parsed.id}`, axe.ruleIds)];
  } catch (err) {
    log.emit("mutator", "warn", `LLM skipped: ${stripSecretsFromText(err instanceof Error ? err.message : String(err))}`);
    return [];
  }
}

export async function runMutator(
  axe: AxeSummary,
  log: EventLog,
  opts?: { generation?: number; champion?: PatchSpec | null },
): Promise<CandidateSpec[]> {
  const generation = opts?.generation ?? 1;
  log.emit("mutator", "start", `template mutator; LLM optional when a key is set (generation ${generation})`);
  const templates = templatesFromViolations(axe, generation, opts?.champion);
  const llm = generation === 1 ? await maybeLlmCandidates(axe, log) : [];
  const all = [...templates, ...llm];
  log.emit("mutator", "done", `${all.length} candidates (${all.filter((c) => c.kind === "canary-reject").length} hostile)`, {
    ids: all.map((item) => item.spec.id),
  });
  return all;
}
