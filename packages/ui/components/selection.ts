// SPDX-License-Identifier: LGPL-3.0-only
/** Binary on/off state is distinct from choosing an item in a collection. */
export function toggle(input: { on: boolean; class?: string }): {
  class: string;
  "aria-pressed": "true" | "false";
} {
  return {
    class: [input.class, "otk-toggle", input.on ? "is-on" : ""].filter(Boolean)
      .join(" "),
    "aria-pressed": input.on ? "true" : "false",
  };
}

/** Selection is declared once; accessibility and visual state cannot diverge.
 * A keyboard candidate may coexist with committed selections (multi-choice).
 */
export function selection(input: {
  selected: boolean;
  kind: "selected" | "current" | "pressed" | "candidate";
  candidate?: boolean;
  /** Keyboard/hover focus without committing the selected pointer. */
  highlighted?: boolean;
  /** A backend-applied value, rather than a stable user choice. */
  applied?: boolean;
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
      input.applied ? "is-applied" : "",
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
