export interface CssFocusStyle {
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
}

/** WCAG 2.4.7: a focus ring is visible when outline width/style or box-shadow changes vs unfocused. */
export function focusIndicatorVisible(focused: CssFocusStyle, unfocused: CssFocusStyle): boolean {
  const width = Number.parseFloat(focused.outlineWidth);
  const style = (focused.outlineStyle || "none").toLowerCase();
  const color = (focused.outlineColor || "").replace(/\s+/g, "");
  const outlineOn =
    style !== "none" &&
    style !== "" &&
    Number.isFinite(width) &&
    width > 0 &&
    color !== "transparent" &&
    color !== "rgba(0,0,0,0)";
  const shadow = (focused.boxShadow || "none").trim();
  const shadowOn = shadow !== "none" && shadow !== "" && shadow !== (unfocused.boxShadow || "none").trim();
  return outlineOn || shadowOn;
}
