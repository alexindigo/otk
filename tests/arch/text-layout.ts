// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { nodes, property, type t } from "./syntax.ts";
import { rules, selectorAlternatives, variables } from "./styles.ts";

const width = /^(?:(?:min|max)-?)?(?:width|inline-?size)$/i;
const text =
  /^(?:label|legend|h[1-6])(?:$|[.#:[\s])|\.[\w-]+-(?:title|label|name|destination|crumb|primary|text|task|target)(?:$|[.#:[\s])/;
const fixedLength =
  /(?:^|[^\w.])(?:\d*\.)?[1-9]\d*(?:\.\d+)?(?:px|ch|em|rem|ex|lh|ic)\b/i;

// Existing owner-specific exceptions; not a path-level exclusion. A new width
// binding must name the geometry source and why CSS cannot own that quantity.
const widthPorts: Record<string, Record<string, string>> = {
  "MetaRow.tsx": {
    "--meta-intrinsic":
      "Ranked whole-item fitting retains the full-form extent across hidden states.",
  },
  "OverflowRow.tsx": {
    "--overflow-item-width":
      "The fit plan distributes the actual compact ancestor widths.",
    "min-inline-size":
      "Caller-supplied CSS control size tokens constrain the discrete fitting contract.",
  },
  "ProjectTabs.tsx": {
    width: "Usage bar paints the reported percentage, not sibling clearance.",
  },
  "ScrollRegion.tsx": {
    width: "The horizontal thumb paints the owned scroll ratio.",
  },
  "SidebarRail.tsx": {
    width: "The transient width is the user's resize input.",
  },
  "VirtualList.tsx": {
    "inline-size": "The virtualizer retains the extent of unmounted content.",
  },
  "UsageDetail.tsx": {
    width: "The reported context fraction paints an in-flow chart.",
  },
  "surface/Popover.tsx": {
    width: "The shared Popover reifies a caller-supplied rect anchor.",
  },
  "packages/ui/features/visual.ts": {
    "--otk-scale":
      "The user's Text size sets a unitless scale, not a measured width.",
  },
  "packages/ui/terminal/ghostty/surface.ts": {
    width:
      "A hidden browser input gives the terminal a keyboard and IME target.",
  },
};

export function textLayoutErrors(files: ReadonlyMap<string, string>): string[] {
  const ui = [...files].filter(([path]) =>
    /^(?:packages\/ui|web\/src)\//.test(path)
  );
  const css = ui.filter(([path]) => path.endsWith(".css")).flatMap((
    [path, contents],
  ) => rules(contents).map((rule) => ({ path, ...rule })));
  const widths = new Set<string>();
  const definitions = new Map<string, string[]>();
  for (const { declarations } of css) {
    for (const [key, value] of declarations) {
      if (
        width.test(key) ||
        /^(?:grid-template(?:-columns)?|flex(?:-basis)?)$/.test(key)
      ) {
        for (const { name } of variables(value)) widths.add(name);
      }
      if (key.startsWith("--")) {
        definitions.set(key, [...(definitions.get(key) ?? []), value]);
      }
    }
  }
  for (const key of widths) {
    for (const value of definitions.get(key) ?? []) {
      for (const { name } of variables(value)) widths.add(name);
    }
  }
  const hasFixed = (value: string, visited = new Set<string>()): boolean =>
    !/^(?:calc-size|fit-content)\(/i.test(value) && (fixedLength.test(value) ||
      variables(value).some(({ name }) =>
        !visited.has(name) &&
        definitions.get(name)?.some((alias) =>
          hasFixed(alias, new Set([...visited, name]))
        )
      ));
  const errors: string[] = [];
  for (const { path, selector, declarations } of css) {
    if (
      !selectorAlternatives(selector).some((branch) =>
        text.test(branch.split(/[ >+~]/).at(-1) ?? "")
      )
    ) continue;
    for (const [key, value] of declarations) {
      if (
        !/^(?:(?:min-)?(?:width|inline-size)|flex-basis)$/.test(key) ||
        !hasFixed(value)
      ) continue;
      errors.push(`${path}: ${selector}: ${key}: ${value}`);
    }
  }
  for (const [path, contents] of ui) {
    if (!/\.tsx?$/.test(path)) continue;
    const source = new Source(contents, path);
    const check = (node: t.Node, key: string | undefined) => {
      if (
        !key ||
        !(width.test(key) || widths.has(key) ||
          /^--.*(?:width|inline-size|intrinsic)$/.test(key))
      ) return;
      const owner = path.replace(/^packages\/ui\/components\//, "");
      if (Object.hasOwn(widthPorts[owner] ?? {}, key)) return;
      errors.push(
        `${path}:${node.loc?.start.line ?? 0}: inline layout width ${key}`,
      );
    };
    const declaration = (node: t.Node) => {
      if (node.type === "ObjectProperty") check(node, property(node.key));
    };
    const checkText = (node: t.Node, value: t.Node | undefined) => {
      const code = value && contents.slice(value.start ?? 0, value.end ?? 0);
      for (
        const match of code?.matchAll(/(?:^|[;"'`])\s*([\w-]+)\s*:/g) ?? []
      ) check(node, match[1]);
    };
    for (const node of source.all) {
      if (node.type === "JSXAttribute" && property(node.name) === "style") {
        const value = source.value(node.value);
        if (!value) continue;
        for (const child of nodes(value)) {
          if (child.type === "ObjectExpression") {
            child.properties.forEach(declaration);
          }
        }
        if (/^(?:String|Template)/.test(value.type)) checkText(node, value);
      } else if (node.type === "AssignmentExpression") {
        const key = source.name(node.left)?.match(/\.style\.([\w-]+)$/)?.[1];
        if (key === "cssText") checkText(node, source.value(node.right));
        else check(node, key);
      } else if (
        node.type === "CallExpression" || node.type === "OptionalCallExpression"
      ) {
        const call = source.name(node.callee);
        if (
          /\.(?:style\.setProperty|attributeStyleMap\.set)$/.test(call ?? "")
        ) check(node, source.string(node.arguments[0]));
        if (
          call?.endsWith(".setAttribute") &&
          source.string(node.arguments[0]) === "style"
        ) {
          checkText(node, source.value(node.arguments[1]));
        }
      }
    }
  }
  return errors;
}
