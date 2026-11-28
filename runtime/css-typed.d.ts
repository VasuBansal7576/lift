export const CSS_STATES: readonly string[];
export const CSS_RULE_LIMIT: number;
export const CSS_DECL_LIMIT: number;
export const CSS_IDENT_MAX: number;

export function cssEscapeIdent(ident: string): string;
export function emitCssNumber(n: number): string | null;
export function cssColorToRgb(value: string): [number, number, number] | null;
export function relativeLuminance(r: number, g: number, b: number): number;
export function contrastRatio(fg: number[], bg: number[]): number;
export function serializeSelectorForQuery(selector: {
  tag?: string;
  classes?: string[];
  id?: string;
  state?: string;
}): string;
export function serializeSelector(selector: {
  tag?: string;
  classes?: string[];
  id?: string;
  state?: string;
}): string;
export function serializeCss(
  rules: {
    selector: { tag?: string; classes?: string[]; id?: string; state?: string };
    declarations: { property: string; value: string }[];
  }[],
): string;
export function parseCssRules(
  rawRules: unknown,
  index: number,
):
  | { error: string }
  | {
      rules: {
        selector: { tag?: string; classes?: string[]; id?: string; state?: string };
        declarations: { property: string; value: string }[];
      }[];
      css: string;
    };
