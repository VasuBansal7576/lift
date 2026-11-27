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
    spec: op([{ op: "injectCSS", css: ".x { color: #111; }" }]),
    ok: true,
  },
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
    name: "css @import",
    spec: op([{ op: "injectCSS", css: "@import url(https://evil.example/x.css);" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css url()",
    spec: op([{ op: "injectCSS", css: "body { background: url(https://evil.example/x.png); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css expression",
    spec: op([{ op: "injectCSS", css: "body { width: expression(alert(1)); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css behavior",
    spec: op([{ op: "injectCSS", css: "body { behavior: url(x.htc); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css -moz-binding",
    spec: op([{ op: "injectCSS", css: "body { -moz-binding: url(x.xml); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css position fixed overlay",
    spec: op([{ op: "injectCSS", css: ".x { position: fixed; z-index: 9999; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css closes style tag",
    spec: op([{ op: "injectCSS", css: "a{} </style><script>alert(1)</script>" }]),
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
];
