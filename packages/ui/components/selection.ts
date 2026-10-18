// SPDX-License-Identifier: LGPL-3.0-only
/** Selection is declared once; accessibility and visual state cannot diverge.
 * A keyboard candidate may coexist with committed selections (multi-choice).
 */
export function selection(input: {
  selected: boolean;
  kind: "selected" | "current" | "pressed" | "candidate";
  candidate?: boolean;
  /** Keyboard/hover focus without committing the selected pointer. */
  highlighted?: boolean;
  class?: string;
}): {
  class: string;
  "aria-selected"?: "true" | "false";
  "aria-current"?: "page";
  "aria-pressed"?: "true" | "false";
} {
  return {
    class: [
      input.class,
      "otk-selection-item",
      input.selected || input.candidate ? "is-selected" : "",
      input.highlighted ? "is-highlighted" : "",
    ].filter(Boolean).join(" "),
    "aria-selected": input.kind === "selected"
      ? (input.selected ? "true" : "false")
      : undefined,
    "aria-current": input.kind === "current" && input.selected
      ? "page"
      : undefined,
    "aria-pressed": input.kind === "pressed"
      ? (input.selected ? "true" : "false")
      : undefined,
  };
}
