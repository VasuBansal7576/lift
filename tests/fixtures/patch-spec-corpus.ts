export type SchemaExpect = boolean | "skip";

export interface CorpusCase {
  name: string;
  spec: unknown;
  ok: boolean;
  error?: string;
  /** When omitted, schema must match `ok`. `"skip"` = parser-only (DOM sanitizer). */
  schema?: SchemaExpect;
}

const op = (ops: object[]) => ({ id: "corpus", version: 0, ops });

export function colorCss(classes: string[] = ["x"], color = "#111", extra?: { id?: string }) {
  const body: Record<string, unknown> = {
    op: "injectCSS",
    rules: [
      {
        selector: { classes },
        declarations: [{ property: "color", value: color }],
      },
    ],
  };
  if (extra?.id) body.id = extra.id;
  return body;
}

export const CSS_TYPED_ACCEPTED: {
  name: string;
  rules: object[];
  probe: { attr: "class" | "id"; value: string; state?: string };
}[] = [
  {
    name: "color hex3",
    rules: [{ selector: { classes: ["c-color"] }, declarations: [{ property: "color", value: "#111" }] }],
    probe: { attr: "class", value: "c-color" },
  },
  {
    name: "background-color rgb",
    rules: [
      {
        selector: { classes: ["c-bg"] },
        declarations: [{ property: "background-color", value: "rgb(255, 255, 255)" }],
      },
    ],
    probe: { attr: "class", value: "c-bg" },
  },
  {
    name: "outline focus",
    rules: [
      {
        selector: { id: "c-outline", state: "focus" },
        declarations: [
          { property: "outline-style", value: "solid" },
          { property: "outline-color", value: "#000" },
          { property: "outline-width", value: "2px" },
          { property: "outline-offset", value: "1px" },
        ],
      },
    ],
    probe: { attr: "id", value: "c-outline", state: "focus" },
  },
  {
    name: "border",
    rules: [
      {
        selector: { classes: ["c-border"] },
        declarations: [
          { property: "border-style", value: "dashed" },
          { property: "border-color", value: "#123456" },
          { property: "border-width", value: "3px" },
        ],
      },
    ],
    probe: { attr: "class", value: "c-border" },
  },
  {
    name: "font and spacing",
    rules: [
      {
        selector: { classes: ["c-font"] },
        declarations: [
          { property: "font-size", value: "16px" },
          { property: "font-weight", value: "700" },
          { property: "line-height", value: 1.5 },
          { property: "letter-spacing", value: "0.1em" },
          { property: "word-spacing", value: "2px" },
        ],
      },
    ],
    probe: { attr: "class", value: "c-font" },
  },
  {
    name: "decoration target padding cursor",
    rules: [
      {
        selector: { classes: ["c-misc"] },
        declarations: [
          { property: "text-decoration-line", value: "underline" },
          { property: "text-decoration-thickness", value: "2px" },
          { property: "min-height", value: "44px" },
          { property: "min-width", value: "44px" },
          { property: "padding", value: "8px" },
          { property: "cursor", value: "pointer" },
        ],
      },
    ],
    probe: { attr: "class", value: "c-misc" },
  },
  {
    name: "font-size em",
    rules: [
      {
        selector: { classes: ["c-em"] },
        declarations: [{ property: "font-size", value: "1.25em" }],
      },
    ],
    probe: { attr: "class", value: "c-em" },
  },
];

export const PATCH_SPEC_CORPUS: CorpusCase[] = [
  { name: "empty ops", spec: { id: "x", version: 0, ops: [] }, ok: true },
  {
    name: "setAttribute aria-label",
    spec: op([{ op: "setAttribute", selector: "#x", name: "aria-label", value: "Go" }]),
    ok: true,
  },
  {
    name: "href fragment",
    spec: op([{ op: "setAttribute", selector: "a", name: "href", value: "#main" }]),
    ok: true,
  },
  {
    name: "href same-origin path",
    spec: op([{ op: "setAttribute", selector: "a", name: "href", value: "/checkout" }]),
    ok: true,
  },
  {
    name: "injectCSS simple",
    spec: op([colorCss(["x"], "#111")]),
    ok: true,
  },
  {
    name: "injectCSS checkout contrast",
    spec: op([
      {
        op: "injectCSS",
        id: "checkout-treatment-css",
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
    ]),
    ok: true,
  },
  ...CSS_TYPED_ACCEPTED.map((item) => ({
    name: `injectCSS accepted ${item.name}`,
    spec: op([{ op: "injectCSS", rules: item.rules }]),
    ok: true,
  })),
  {
    name: "insertHTML skip link",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "prepend",
        html: '<a href="#main">Skip</a>',
        mountId: "skip",
      },
    ]),
    ok: true,
  },
  { name: "not an object", spec: null, ok: false, error: "spec must be an object" },
  { name: "missing id", spec: { version: 0, ops: [] }, ok: false, error: "id required" },
  {
    name: "unsupported version",
    spec: { id: "x", version: 1, ops: [] },
    ok: false,
    error: "unsupported version: 1",
  },
  {
    name: "ops not array",
    spec: { id: "x", version: 0, ops: {} },
    ok: false,
    error: "ops must be an array",
  },
  {
    name: "missing op",
    spec: op([{ selector: "body" }]),
    ok: false,
    error: "ops[0] missing op",
  },
  {
    name: "unknown op",
    spec: op([{ op: "eval", selector: "body" }]),
    ok: false,
    error: "ops[0] unknown op: eval",
  },
  {
    name: "onclick attribute",
    spec: op([{ op: "setAttribute", selector: "a", name: "onclick", value: "alert(1)" }]),
    ok: false,
    error: "ops[0] disallowed attribute",
  },
  {
    name: "href protocol-relative",
    spec: op([{ op: "setAttribute", selector: "a", name: "href", value: "//evil.example" }]),
    ok: false,
    error: "ops[0] unsafe attribute value",
  },
  {
    name: "href backslash",
    spec: op([{ op: "setAttribute", selector: "a", name: "href", value: "/\\evil" }]),
    ok: false,
    error: "ops[0] unsafe attribute value",
  },
  {
    name: "javascript href",
    spec: op([{ op: "setAttribute", selector: "a", name: "href", value: "javascript:alert(1)" }]),
    ok: false,
    error: "ops[0] unsafe attribute value",
  },
  {
    name: "raw css string rejected",
    spec: op([{ op: "injectCSS", css: ".x { color: #111; }" }]),
    ok: false,
    error: "ops[0] rules required",
  },
  {
    name: "css @import",
    spec: op([{ op: "injectCSS", css: "@import url(https://evil.example/x.css);" }]),
    ok: false,
    error: "ops[0] rules required",
  },
  {
    name: "css url()",
    spec: op([{ op: "injectCSS", css: "body { background: url(https://evil.example/x.png); }" }]),
    ok: false,
    error: "ops[0] rules required",
  },
  {
    name: "css expression",
    spec: op([{ op: "injectCSS", css: "body { width: expression(alert(1)); }" }]),
    ok: false,
    error: "ops[0] rules required",
  },
  {
    name: "css comment smuggling",
    spec: op([
      {
        op: "injectCSS",
        css: 'h1{color:"/*"; background-image:url(http://x/leak) /* */}',
      },
    ]),
    ok: false,
    error: "ops[0] rules required",
  },
  {
    name: "css :is(body)",
    spec: op([{ op: "injectCSS", css: ":is(body){opacity:0}" }]),
    ok: false,
    error: "ops[0] rules required",
  },
  {
    name: "css escaped url as raw text",
    spec: op([{ op: "injectCSS", css: ".x { color: \\75 rl(http://evil.example); }" }]),
    ok: false,
    error: "ops[0] rules required",
  },
  {
    name: "typed comment smuggling value",
    spec: op([
      {
        op: "injectCSS",
        rules: [{ selector: { classes: ["x"] }, declarations: [{ property: "color", value: "/*" }] }],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed u\\72l(",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "color", value: "u\\72l(http://evil.example)" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed #fff0 alpha hex",
    spec: op([
      {
        op: "injectCSS",
        rules: [{ selector: { classes: ["x"] }, declarations: [{ property: "color", value: "#fff0" }] }],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed rgb slash alpha",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "color", value: "rgb(0 0 0 / 0)" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed rgba",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "color", value: "rgba(0, 0, 0, 0)" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed outline shorthand 3000px",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "outline", value: "3000px" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed outline-width 3000px",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "outline-width", value: "3000px" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed bare type selector",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { tag: "p" },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed compounding bare type selectors",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { tag: "div" },
            declarations: [{ property: "color", value: "#111" }],
          },
          {
            selector: { tag: "span" },
            declarations: [{ property: "color", value: "#000" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed html target",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { tag: "html", classes: ["x"] },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed body target",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { tag: "body", classes: ["x"] },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed head target",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { tag: "head", id: "x" },
            declarations: [{ property: "color", value: "#111" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed display none",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "display", value: "none" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed opacity",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "opacity", value: "0" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "typed important in value",
    spec: op([
      {
        op: "injectCSS",
        rules: [
          {
            selector: { classes: ["x"] },
            declarations: [{ property: "color", value: "#111 !important" }],
          },
        ],
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "insertHTML script",
    spec: op([{ op: "insertHTML", selector: "body", position: "append", html: "<script>x</script>" }]),
    ok: false,
    error: "ops[0] html is not allowlisted",
  },
  {
    name: "insertHTML onerror",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: "<img src=x onerror=alert(1)>",
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
  },
  {
    name: "insertHTML javascript&colon;",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: '<a href="javascript&colon;alert(1)">x</a>',
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
    schema: "skip",
  },
  {
    name: "insertHTML numeric entity javascript",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: '<a href="&#106;avascript:alert(1)">x</a>',
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
    schema: "skip",
  },
  {
    name: "insertHTML formaction",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: '<button formaction="javascript:alert(1)">x</button>',
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
  },
  {
    name: "insertHTML svg xlink",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
  },
  {
    name: "insertHTML base href",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: '<base href="https://evil.example/">',
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
  },
  {
    name: "insertHTML external img",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: '<img src="https://evil.example/x.png">',
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
  },
  {
    name: "replaceTag script",
    spec: op([{ op: "replaceTag", selector: "#x", tag: "script" }]),
    ok: false,
    error: "ops[0] tag is not allowlisted",
  },
  {
    name: "mountId injection",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: "<span>x</span>",
        mountId: 'x"][data-x',
      },
    ]),
    ok: false,
    error: "ops[0] mountId is invalid",
  },
  {
    name: "empty html",
    spec: op([{ op: "insertHTML", selector: "body", position: "append", html: "" }]),
    ok: false,
    error: "ops[0] html required",
  },
  {
    name: "insertHTML id attr",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: '<a id="clobber" href="#main">x</a>',
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
    schema: "skip",
  },
  {
    name: "insertHTML name attr",
    spec: op([
      {
        op: "insertHTML",
        selector: "body",
        position: "append",
        html: '<a name="clobber" href="#main">x</a>',
      },
    ]),
    ok: false,
    error: "ops[0] html is not allowlisted",
    schema: "skip",
  },
  {
    name: "setAttribute id",
    spec: op([{ op: "setAttribute", selector: "#x", name: "id", value: "clobber" }]),
    ok: false,
    error: "ops[0] disallowed attribute",
  },
  {
    name: "setAttribute name",
    spec: op([{ op: "setAttribute", selector: "#x", name: "name", value: "clobber" }]),
    ok: false,
    error: "ops[0] disallowed attribute",
  },
  {
    name: "setText style tag",
    spec: op([{ op: "setText", selector: "style", text: "body{display:none}" }]),
    ok: false,
    error: "ops[0] target is not allowlisted",
  },
  {
    name: "setAttribute type hidden",
    spec: op([{ op: "setAttribute", selector: "input", name: "type", value: "hidden" }]),
    ok: false,
    error: "ops[0] disallowed attribute",
  },
  {
    name: "setAttribute data-lift reserved",
    spec: op([{ op: "setAttribute", selector: "#x", name: "data-lift-x", value: "1" }]),
    ok: false,
    error: "ops[0] disallowed attribute",
  },
  {
    name: "replaceTag a without href",
    spec: op([{ op: "replaceTag", selector: "#x", tag: "a" }]),
    ok: false,
    error: "ops[0] a requires href",
  },
  {
    name: "replaceTag body",
    spec: op([{ op: "replaceTag", selector: "body", tag: "span" }]),
    ok: false,
    error: "ops[0] target is not allowlisted",
  },
  {
    name: "setText body",
    spec: op([{ op: "setText", selector: "body", text: "gone" }]),
    ok: false,
    error: "ops[0] target is not allowlisted",
  },
  {
    name: "setText head",
    spec: op([{ op: "setText", selector: "head", text: "gone" }]),
    ok: false,
    error: "ops[0] target is not allowlisted",
  },
  {
    name: "setAttribute form host",
    spec: op([{ op: "setAttribute", selector: "form", name: "aria-label", value: "x" }]),
    ok: false,
    error: "ops[0] target is not allowlisted",
  },
  {
    name: "makeFocusable body",
    spec: op([{ op: "makeFocusable", selector: "body" }]),
    ok: false,
    error: "ops[0] target is not allowlisted",
  },
  {
    name: "bindEnterToClick form",
    spec: op([{ op: "bindEnterToClick", selector: "form" }]),
    ok: false,
    error: "ops[0] target is not allowlisted",
  },
];

export const CSS_ATTACKS = PATCH_SPEC_CORPUS.filter(
  (fixture) =>
    !fixture.ok &&
    typeof fixture.spec === "object" &&
    fixture.spec !== null &&
    Array.isArray((fixture.spec as { ops?: unknown }).ops) &&
    (fixture.spec as { ops: { op?: string }[] }).ops.some((item) => item.op === "injectCSS"),
).map((fixture) => ({
  name: fixture.name,
  spec: fixture.spec,
}));

export const INSERT_HTML_ATTACKS = PATCH_SPEC_CORPUS.filter(
  (fixture) =>
    !fixture.ok &&
    typeof fixture.spec === "object" &&
    fixture.spec !== null &&
    Array.isArray((fixture.spec as { ops?: unknown }).ops) &&
    (fixture.spec as { ops: { op?: string }[] }).ops.some((item) => item.op === "insertHTML"),
);
