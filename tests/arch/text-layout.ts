// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { nodes, property, type t } from "./syntax.ts";
import { rules, selectorAlternatives, variables } from "./styles.ts";

const width = /^(?:(?:min|max)-?)?(?:width|inline-?size)$/i;
const text =
  /^(?:label|legend|h[1-6])(?:$|[.#:[\s])|\.[\w-]+-(?:title|label|name|destination|crumb|primary|text|task|target)(?:$|[.#:[\s])/;
const fixedLength =
  /(?:^|[^\w.])(?:\d*\.)?[1-9]\d*(?:\.\d+)?(?:px|ch|em|rem|ex|lh|ic)\b/i;
const scalar = String.raw`[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?`;
const cssVar = String.raw`var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)`;
const scaledLength = new RegExp(
  String
    .raw`(?:^|[\s(,*/+-])${scalar}\s*\*\s*${cssVar}|${cssVar}\s*\*\s*${scalar}(?=[\s),*/+-]|$)`,
  "gi",
);
const unitToken = /^--(?:[\w-]+-)?(?:unit|px)$/;
const unitAlias = new RegExp(`^${cssVar}$`);
// Shared lane bounds, gutters, and named hit/artwork sizes are a design
// contract, not component-local fixed widths. Multiplying a raw unit still
// counts even if the result is assigned to a local variable.
const semanticLengths: Record<string, RegExp> = {
  "packages/ui/theme.css":
    /^--(?:space-\d+|(?:lane|overlay|popover)-gutter|(?:lane|rail)-width|(?:form-control|control|send-button)-size|control-inner-size|icon-compact|avatar-compact|row-(?:compact|project))$/,
  "packages/ui/components/CodeBlock.css": /^--control-size$/,
  "packages/ui/components/ControlValue.css": /^--control-inner-size$/,
  "packages/ui/components/Tree.css":
    /^--(?:tree-indent|tree-box-size|selection-mark)$/,
  "packages/ui/components/ActivityIndicator.css": /^--activity-size$/,
  "packages/ui/components/ConnectionLight.css": /^--connection-size$/,
  "packages/ui/components/StatusLight.css": /^--lamp-size$/,
  "packages/ui/components/LiveLink.css": /^--live-link-light$/,
};

// Individual artwork dimensions, not layout exceptions. Match the declaration
// as well as the owner so that adding another fixed width there still fails.
const artWidths: Record<string, Record<string, string>> = {
  "packages/ui/components/EdgeTriangle.css": {
    ".otk-edge-triangle svg: inline-size: calc(16*var(--otk-unit))":
      "Edge-navigation glyph inside its independent hit target.",
  },
  "packages/ui/components/ProjectChip.css": {
    ".otk-project-avatar: width: calc(18*var(--otk-unit))": "Avatar artwork.",
    ".otk-project-chip-menu-row svg: width: calc(16*var(--otk-unit))":
      "Artwork in a menu control, not the menu width.",
  },
  "packages/ui/components/ScrollRegion.css": {
    ".otk-scroll-track-y>.otk-scroll-thumb: width: calc(4*var(--otk-unit))":
      "Thickness of the painted scroll thumb, not the scrollport.",
  },
  "packages/ui/components/TakeoverHeader.css": {
    ".otk-takeover-chevron: width: calc(16*var(--otk-unit))":
      "Chevron artwork.",
  },
  "packages/ui/components/WorkPanelView.css": {
    ".otk-work-axis: inline-size: calc(56*var(--otk-unit))":
      "SVG duration glyph with a fixed presentation scale.",
  },
  "packages/ui/features/project-settings.css": {
    ".otk-project-color-swatch: width: calc(18*var(--otk-unit))":
      "Swatch artwork within the shared form hit target.",
  },
  "packages/ui/theme.css": {
    ".otk-chrome-icon: width: calc(16*var(--otk-unit))": "Shared icon artwork.",
    ":root [data-otk-selection=vertical].otk-selection-item::before: width: calc(3*var(--otk-unit))":
      "Selection marker stroke, not a reservation for row text.",
  },
};

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
    "--usage-metrics":
      "Only the number of reported columns is emitted; CSS sizes each track from its cells.",
  },
  "WorkStrip.tsx": {
    "--work-segments":
      "The chart's unitless item count shares one bounded track; it never measures or sets a text width.",
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
  const layoutDefinitions = new Map<string, string[]>();
  for (const { path, declarations } of css) {
    for (const [key, value] of declarations) {
      if (
        width.test(key) ||
        /^(?:grid-template(?:-columns)?|flex(?:-basis)?)$/.test(key)
      ) {
        for (const { name } of variables(value)) widths.add(name);
      }
      if (key.startsWith("--")) {
        definitions.set(key, [...(definitions.get(key) ?? []), value]);
        if (!semanticLengths[path]?.test(key)) {
          layoutDefinitions.set(key, [
            ...(layoutDefinitions.get(key) ?? []),
            value,
          ]);
        }
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
  const resolvesUnit = (name: string, visited = new Set<string>()): boolean =>
    unitToken.test(name) || (!visited.has(name) &&
      (definitions.get(name) ?? []).some((value) => {
        const alias = value.match(unitAlias)?.[1];
        return alias && resolvesUnit(alias, new Set([...visited, name]));
      }));
  const hasScaled = (value: string, visited = new Set<string>()): boolean =>
    [...value.matchAll(scaledLength)].some((match) =>
      resolvesUnit(match[1] ?? match[2])
    ) || variables(value).some(({ name }) =>
      !visited.has(name) && layoutDefinitions.get(name)?.some((alias) =>
        hasScaled(alias, new Set([...visited, name]))
      )
    );
  const errors: string[] = [];
  for (const { path, selector, declarations } of css) {
    const isText = selectorAlternatives(selector).some((branch) =>
      text.test(branch.split(/[ >+~]/).at(-1) ?? "")
    );
    for (const [key, value] of declarations) {
      const declaration = `${selector}: ${key}: ${value}`;
      const scaled = /^(?:(?:(?:min|max)-)?(?:width|inline-size)|flex-basis)$/
        .test(key) &&
        hasScaled(value) &&
        !Object.hasOwn(artWidths[path] ?? {}, declaration);
      const fixedText = isText &&
        /^(?:(?:min-)?(?:width|inline-size)|flex-basis)$/.test(key) &&
        hasFixed(value);
      if (!scaled && !fixedText) continue;
      errors.push(`${path}: ${declaration}`);
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
