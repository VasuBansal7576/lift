export const CSS_STATES: readonly string[];

export function cssEscapeIdent(ident: string): string;
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
