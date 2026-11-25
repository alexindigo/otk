// SPDX-License-Identifier: LGPL-3.0-only
import { cssTree, outOfFlow, rules } from "./styles.ts";

/** Composer work chrome is in flow and has a single owner per spacing role. */
export function composerHeaderErrors(
  files: ReadonlyMap<string, string>,
): string[] {
  const errors: string[] = [];
  const css = (file: string) => files.get(`${file}.css`) ?? "";
  const check = (
    file: string,
    selector: string,
    declarations: Record<string, string>,
  ) => {
    const rule = rules(css(file)).find((r) =>
      !r.condition && r.selector === selector
    );
    for (const [prop, value] of Object.entries(declarations)) {
      if (rule?.declarations.get(prop) !== value) {
        errors.push(`${selector}: expected ${prop}: ${value}`);
      }
    }
  };
  check("ComposerTakeovers", ".otk-composer-live-slot", {
    display: "flex",
    gap: "var(--space-4)",
  });
  check("LiveCount", ".otk-live-count", { gap: "var(--space-2)" });
  for (const file of ["Subagents", "LiveWork"]) {
    for (const { selector, declarations } of rules(css(file))) {
      if (
        selector.includes("-trigger") &&
        [...declarations.keys()].some((p) =>
          /^(?:(?:row|column)-)?gap$/.test(p)
        )
      ) {
        errors.push(`${selector}: trigger must not own lamp spacing`);
      }
    }
  }
  check("LiveLink", ".otk-live-link", {
    flex: "1 1 0",
    "min-inline-size": "var(--space-6)",
  });
  for (const { selector, declarations, condition } of rules(css("LiveLink"))) {
    if (!condition.includes("@keyframes ") && outOfFlow(declarations)) {
      errors.push(`${selector}: link must stay in flow`);
    }
  }
  cssTree.walk(cssTree.parse(css("LiveLink")), {
    visit: "Declaration",
    enter(node) {
      if (
        this.atrule?.name === "keyframes" && this.atrule.prelude &&
        cssTree.generate(this.atrule.prelude) === "otk-live-link-travel" &&
        node.property !== "translate"
      ) {
        errors.push(`otk-live-link-travel: unexpected ${node.property}`);
      }
    },
  });
  if (
    /\b(?:setInterval|setTimeout|requestAnimationFrame|createSignal)\b/.test(
      files.get("LiveLink.tsx") ?? "",
    )
  ) {
    errors.push("LiveLink.tsx: motion must be CSS only");
  }
  check("Subagents", ".otk-subagent-row", {
    "grid-template-columns": "subgrid",
  });
  for (const { selector, declarations } of rules(css("Subagents"))) {
    if (
      /\.otk-subagent-(?:row|name|navigation|time|stop|ago)\b/.test(selector)
    ) {
      for (const prop of declarations.keys()) {
        if (prop === "position" || prop.startsWith("margin-inline-")) {
          errors.push(`${selector}: row layout must not use ${prop}`);
        }
      }
    }
  }
  return errors;
}
