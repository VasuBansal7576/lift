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
  {
    name: "css escaped url",
    spec: op([{ op: "injectCSS", css: ".x { color: \\75 rl(http://evil.example); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css escaped import",
    spec: op([{ op: "injectCSS", css: "@\\69mport 'http://evil.example';" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css image-set",
    spec: op([{ op: "injectCSS", css: ".x { color: image-set('//evil.example' 1x); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css escaped position fixed",
    spec: op([{ op: "injectCSS", css: ".x { position: \\66 ixed; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css comment position fixed",
    spec: op([{ op: "injectCSS", css: ".x { position:/**/fixed; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css comment import",
    spec: op([{ op: "injectCSS", css: "@/**/import 'x';" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css src()",
    spec: op([{ op: "injectCSS", css: ".x { color: src(http://evil.example); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css element()",
    spec: op([{ op: "injectCSS", css: ".x { color: element(#x); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css paint()",
    spec: op([{ op: "injectCSS", css: ".x { color: paint(foo); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css body display none",
    spec: op([{ op: "injectCSS", css: "body{display:none}" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css html selector",
    spec: op([{ op: "injectCSS", css: "html .x { color: #111; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css star selector",
    spec: op([{ op: "injectCSS", css: "* { color: #111; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css :root selector",
    spec: op([{ op: "injectCSS", css: ":root { color: #111; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css display none",
    spec: op([{ op: "injectCSS", css: ".x { display: none; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css absolute overlay",
    spec: op([{ op: "injectCSS", css: ".x { position: absolute; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
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
    name: "css string-hidden comment url",
    spec: op([
      {
        op: "injectCSS",
        css: 'h1{color:"/*"; background-image:url(http://x/leak) /* */}',
      },
    ]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css :is(body)",
    spec: op([{ op: "injectCSS", css: ":is(body){opacity:0}" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css :where(html)",
    spec: op([{ op: "injectCSS", css: ":where(html){opacity:0}" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css :not(.zzz)",
    spec: op([{ op: "injectCSS", css: ":not(.zzz){font-size:0}" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css :has(*)",
    spec: op([{ op: "injectCSS", css: ":has(*){opacity:0}" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css :scope",
    spec: op([{ op: "injectCSS", css: ":scope { color: #111; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css namespace *|*",
    spec: op([{ op: "injectCSS", css: "*|* { color: #111; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css namespace *|body",
    spec: op([{ op: "injectCSS", css: "*|body { color: #111; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css bare attribute selector",
    spec: op([{ op: "injectCSS", css: "[lang] { color: #111; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css :first-child",
    spec: op([{ op: "injectCSS", css: ".x:first-child { color: #111; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css visibility hidden",
    spec: op([{ op: "injectCSS", css: ".x { visibility: hidden; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css clip-path",
    spec: op([{ op: "injectCSS", css: ".x { clip-path: inset(0); }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css opacity zero",
    spec: op([{ op: "injectCSS", css: ".x { opacity: 0; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css font-size zero",
    spec: op([{ op: "injectCSS", css: ".x { font-size: 0; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css transparent color",
    spec: op([{ op: "injectCSS", css: ".x { color: transparent; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
  },
  {
    name: "css huge margin",
    spec: op([{ op: "injectCSS", css: ".x { margin: 999px; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css huge width",
    spec: op([{ op: "injectCSS", css: ".x { width: 9999px; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
  },
  {
    name: "css oversized hex escape",
    spec: op([{ op: "injectCSS", css: ".x { color: \\110000; }" }]),
    ok: false,
    error: "ops[0] css is not allowlisted",
    schema: "skip",
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
  css: ((fixture.spec as { ops: { css: string }[] }).ops.find((item) => item.css) as { css: string })
    .css,
}));

export const INSERT_HTML_ATTACKS = PATCH_SPEC_CORPUS.filter(
  (fixture) =>
    !fixture.ok &&
    typeof fixture.spec === "object" &&
    fixture.spec !== null &&
    Array.isArray((fixture.spec as { ops?: unknown }).ops) &&
    (fixture.spec as { ops: { op?: string }[] }).ops.some((item) => item.op === "insertHTML"),
);
