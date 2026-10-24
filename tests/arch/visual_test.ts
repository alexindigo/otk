// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { Source, uiSources } from "./analysis.ts";
import { rules, typographyErrors, words } from "./styles.ts";
import { property, type t } from "./syntax.ts";
import { resizeBypasses, typographyBypasses } from "./bypasses.ts";
resizeBypasses(resizeErrors);
typographyBypasses(visualErrors);

for (
  const source of [
    '<button {...selection({kind:"candidate", selected:false, candidate:active})} />',
    '<button {...selection({["kind"]:"candidate", ["selected"]:false, ["candidate"]:active})} />',
  ]
) {
  Deno.test(`A12 independent candidate still requires orientation ${source}`, () => {
    assert(selectionErrors(source).length > 0, `Bypass accepted: ${source}`);
  });
}

Deno.test("A12 orientation accepts permanently unselected metadata but not arbitrary candidate marks", () => {
  for (
    const source of [
      '<span {...selection({kind:"candidate", selected:false, applied:defaulted})} />',
      '<span {...selection({["kind"]:"candidate", ["selected"]:false, ["candidate"]:false})} />',
      '<button data-otk-selection="vertical" {...selection({kind:"candidate", selected:false, candidate:active})} />',
    ]
  ) assertEquals(selectionErrors(source), [], source);
});

const continuousMotionOwners = new Set([
  "components/StatusLight.css",
  "components/ResponseProgress.css",
]);

/** Both shared rules cover elements and their pseudo-elements, with priority. */
function motionSuppressionErrors(shared: string): string[] {
  const errors: string[] = [];
  const parsed = rules(shared);
  if (
    !["*", "*::before", "*::after"].every((selector) =>
      parsed.some((rule) =>
        rule.selector === selector &&
        rule.condition.replace(/\s+/g, "").includes(
          "@media(prefers-reduced-motion:reduce)",
        ) && rule.declarations.get("animation") === "none !important"
      )
    )
  ) errors.push("continuous motion must honour OS reduced motion");
  if (
    !["*", "*::before", "*::after"].every((selector) =>
      parsed.some((rule) =>
        rule.selector === `:root[data-otk-animations-off] ${selector}` &&
        rule.declarations.get("animation") === "none !important"
      )
    )
  ) errors.push("continuous motion must honour Animations off");
  return errors;
}

export function visualErrors(
  css: string,
  base = false,
  motionOwner = false,
  shared = "",
): string[] {
  const errors: string[] = [];
  if (
    !motionOwner &&
    rules(css).some((rule) =>
      [...rule.declarations].some(([prop, value]) =>
        /^(?:animation|animation-iteration-count)$/.test(prop) &&
        words(value).includes("infinite")
      )
    )
  ) {
    errors.push("continuous motion belongs to declared owners");
  }
  if (motionOwner) errors.push(...motionSuppressionErrors(shared));
  errors.push(...typographyErrors(css, base));
  return errors;
}
Deno.test("visual typography and spacing stay behind the shared contract", async () => {
  const ui = new URL("../../packages/ui/", import.meta.url);
  const shared = await Deno.readTextFile(new URL("theme.css", ui));
  const seen = new Set<string>();
  for (const [path, css] of await uiSources()) {
    if (path.endsWith(".css")) {
      const relative = path.replace(/^packages\/ui\//, "");
      const motionOwner = continuousMotionOwners.has(relative);
      if (motionOwner) seen.add(relative);
      assertEquals(
        visualErrors(
          css,
          path === "packages/ui/theme.css",
          motionOwner,
          shared,
        ),
        [],
        path,
      );
    }
  }
  assertEquals(
    seen,
    continuousMotionOwners,
    "Every declared owner must be checked",
  );
  const app = await Deno.readTextFile(
    new URL("../../web/src/ui/App.css", import.meta.url),
  );
  assertEquals(visualErrors(app), []);
  for (
    const invalid of [
      '.x { font-family: "IBM Plex Sans"; }',
      ".x { font-size: .8rem; }",
      ".x { padding: 9px; }",
      ".x { gap: .5rem; }",
      ".x { animation: spin 1s linear infinite; }",
    ]
  ) assert(visualErrors(invalid).length > 0);
  assertEquals(
    visualErrors(
      ".x { font: 400 13px/20px var(--font-ui); padding: 8px 12px; }",
    ),
    [],
  );
  assertEquals(
    visualErrors(".expanded { animation: open 120ms ease-out; }"),
    [],
    "User-action motion remains allowed by the spec",
  );
});

Deno.test("continuous-motion owners require shared suppression and arbitrary animations remain rejected", async () => {
  const shared = await Deno.readTextFile(
    new URL("../../packages/ui/theme.css", import.meta.url),
  );
  const continuous = ".progress { animation: shimmer 2s linear infinite; }";
  assertEquals(visualErrors(continuous), [
    "continuous motion belongs to declared owners",
  ]);
  assertEquals(
    visualErrors(".progress { animation-iteration-count: infinite; }"),
    ["continuous motion belongs to declared owners"],
  );
  assertEquals(visualErrors(continuous, false, true, shared), []);
  for (const owner of continuousMotionOwners) {
    const css = await Deno.readTextFile(
      new URL(`../../packages/ui/${owner}`, import.meta.url),
    );
    assertEquals(visualErrors(css, false, true, shared), [], owner);
    assertEquals(
      visualErrors(
        css,
        false,
        true,
        shared.replace(
          "prefers-reduced-motion: reduce",
          "prefers-reduced-motion: no-preference",
        ),
      ),
      ["continuous motion must honour OS reduced motion"],
      owner,
    );
    assertEquals(
      visualErrors(
        css,
        false,
        true,
        shared.replaceAll("[data-otk-animations-off]", "[data-other]"),
      ),
      ["continuous motion must honour Animations off"],
      owner,
    );
    assert(
      motionSuppressionErrors(
        shared.replaceAll("animation: none !important;", "animation: none;"),
      ).length === 2,
    );
    assert(
      motionSuppressionErrors(shared.replaceAll("*::before", ".other::before"))
        .length === 2,
    );
    assert(
      motionSuppressionErrors(shared.replaceAll("*::after", ".other::after"))
        .length === 2,
    );
  }
});

/** Conservative syntax proof: accept only forms whose complete value set is
 * literal orientations. Unknown expressions fail closed, even if well typed. */
function selectionOrientation(value: t.Node): boolean {
  const expression = value.type === "JSXExpressionContainer"
    ? value.expression
    : value;
  const literal = (node: t.Node) =>
    node.type === "StringLiteral" &&
    ["vertical", "horizontal"].includes(node.value);
  const member = (node: t.Node): boolean =>
    node.type === "Identifier" ||
    node.type === "MemberExpression" && !node.computed && member(node.object);
  const predicate = (node: t.Node): boolean =>
    member(node) ||
    node.type === "CallExpression" && node.arguments.length === 0 &&
      member(node.callee) ||
    node.type === "UnaryExpression" && node.operator === "!" &&
      predicate(node.argument);
  return literal(expression) ||
    expression.type === "ConditionalExpression" && predicate(expression.test) &&
      literal(expression.consequent) && literal(expression.alternate);
}
export function selectionErrors(source: string): string[] {
  let parsed: Source;
  const error = "selected chrome item bypasses the shared selection primitive";
  try {
    parsed = new Source(source);
  } catch {
    return [error];
  }
  const result: string[] = [];
  for (const node of parsed.all) {
    if (node.type !== "JSXOpeningElement") continue;
    // Native listbox options (e.g. prompt completions) are not chrome items.
    if (parsed.string(parsed.attr(node, "role")) === "option") {
      let ancestor = parsed.parent.get(node);
      let listbox = false;
      while (ancestor) {
        if (
          ancestor.type === "JSXElement" &&
          parsed.string(parsed.attr(ancestor.openingElement, "role")) ===
            "listbox"
        ) listbox = true;
        ancestor = parsed.parent.get(ancestor);
      }
      if (listbox) continue;
    }
    const selected = node.attributes.some((a) => {
      if (a.type === "JSXAttribute" && a.name.type === "JSXIdentifier") {
        return [
          "aria-selected",
          "aria-current",
          "aria-pressed",
          "data-selected",
        ].includes(a.name.name);
      }
      if (
        a.type !== "JSXSpreadAttribute" ||
        a.argument.type !== "CallExpression" ||
        parsed.name(a.argument.callee) !== "selection"
      ) return false;
      const options = parsed.value(a.argument.arguments[0]);
      if (options?.type !== "ObjectExpression") return true;
      const field = (name: string) => {
        const state = options.properties.findLast((p) =>
          p.type === "ObjectProperty" && property(p.key) === name
        );
        return state?.type === "ObjectProperty"
          ? parsed.value(state.value)
          : undefined;
      };
      const selected = field("selected"), candidate = field("candidate");
      const never = (value: t.Node | undefined) =>
        value?.type === "BooleanLiteral" && !value.value;
      return !never(selected) || !!candidate && !never(candidate) ||
        options.properties.some((p) => p.type === "SpreadElement");
    });
    if (!selected) continue;
    const attribute = parsed.attr(node, "data-otk-selection");
    if (!attribute || !selectionOrientation(attribute)) result.push(error);
  }
  return result;
}
Deno.test("chrome selected/current states opt into the shared orientation primitive", async () => {
  for (const [path, source] of await uiSources()) {
    if (!path.endsWith(".css")) {
      assertEquals(selectionErrors(source), [], path);
    }
  }
  assertEquals(
    selectionErrors('<button aria-current={selected ? "page" : undefined}>'),
    ["selected chrome item bypasses the shared selection primitive"],
  );
  assertEquals(
    selectionErrors(
      '<button data-otk-selection="vertical" {...selection({ kind: "current", selected })} />',
    ),
    [],
  );
});

Deno.test("chrome orientation expressions prove every possible result is a literal orientation", () => {
  const item = (attribute: string) =>
    `<button ${attribute} {...selection({ kind: "selected", selected })} />`;
  for (
    const valid of [
      'data-otk-selection="horizontal"',
      "data-otk-selection='vertical'",
      'data-otk-selection={"vertical"}',
      "data-otk-selection={'horizontal'}",
      'data-otk-selection={input.rail ? "vertical" : "horizontal"}',
      "data-otk-selection={props.expanded ? 'horizontal' : 'vertical'}",
      'data-otk-selection={!collapsed() ? "horizontal" : "vertical"}',
      'data-otk-selection={rail ? "vertical" : "vertical"}',
    ]
  ) assertEquals(selectionErrors(item(valid)), [], valid);
  for (
    const invalid of [
      "",
      'data-otk-selection="diagonal"',
      'data-otk-selection={""}',
      "data-otk-selection={orientation}",
      "data-otk-selection={props.orientation}",
      'data-otk-selection={rail ? "vertical" : "diagonal"}',
      'data-otk-selection={rail ? "diagonal" : "horizontal"}',
      'data-otk-selection={rail ? "vertical" : undefined}',
      'data-otk-selection={rail ? undefined : "horizontal"}',
      'data-otk-selection={rail ? "vertical" : other}',
      'data-otk-selection={rail ? other : "horizontal"}',
      'data-otk-selection={rail ? "vertical" :}',
      'data-otk-selection={orientation || "vertical"}',
      'data-otk-selection={rail ? "vertical" : "horizontal", other}',
      'data-otk-selection={() => rail ? "vertical" : "horizontal"}',
      'data-otk-selection={rail ? "vertical" : nested ? "horizontal" : other}',
      "data-otk-selection={`vertical${suffix}`}",
    ]
  ) {
    assertEquals(selectionErrors(item(invalid)), [
      "selected chrome item bypasses the shared selection primitive",
    ], invalid);
  }
});

export function resizeErrors(source: string): string[] {
  const parsed = new Source(source);
  const error = [
    "resizing must use an immutable pointer-delta gesture, not a parent edge",
  ];
  if (
    parsed.all.some((node) =>
      parsed.name(node)?.includes("parentElement.getBoundingClientRect")
    )
  ) return error;
  for (const call of parsed.calls("createResize")) {
    const imported = parsed.imported(call.callee);
    if (
      imported?.module !== "./resize.ts" || imported.name !== "createResize"
    ) continue;
    const wired = parsed.all.some((node) => {
      if (node.type !== "JSXSpreadAttribute") return false;
      const access = parsed.access(node.argument);
      return access?.binding.value === call &&
        access.fields.join(".") === "handlers";
    });
    const overrides = parsed.all.some((node) =>
      node.type === "JSXAttribute" &&
      [
        "onKeyDown",
        "onPointerDown",
        "onPointerMove",
        "onPointerUp",
        "onPointerCancel",
        "onLostPointerCapture",
      ].includes(parsed.name(node.name) ?? "")
    );
    if (wired && !overrides) return [];
  }
  for (const call of parsed.calls("resizeDrag")) {
    const assignment = parsed.parent.get(call);
    const target = assignment?.type === "AssignmentExpression"
      ? assignment.left
      : assignment?.type === "VariableDeclarator"
      ? assignment.id
      : undefined;
    if (target?.type !== "Identifier") continue;
    const binding = parsed.binding(target.name, target);
    const consumers = parsed.calls(target.name).filter((node) =>
      node !== call && node.callee.type === "Identifier" &&
      parsed.binding(node.callee.name, node.callee) === binding
    );
    if (
      consumers.some((node) => {
        let current = parsed.parent.get(node);
        while (
          current &&
          !["ExpressionStatement", "ReturnStatement", "CallExpression"]
            .includes(current.type)
        ) current = parsed.parent.get(current);
        return current?.type === "CallExpression" ||
          current?.type === "ReturnStatement";
      })
    ) return [];
  }
  return error;
}
Deno.test("both column resizers share border-independent pointer-delta ownership", async () => {
  const owner = new Source(
    await Deno.readTextFile(
      new URL("../../packages/ui/components/resize.ts", import.meta.url),
    ),
  );
  assertEquals(owner.calls("resizeDrag").length, 1);
  assertEquals(
    owner.calls("move").filter((call) =>
      owner.name(call.callee) === "current.move"
    ).length,
    2,
  );
  for (const name of ["ProjectInbox", "RightPanel"]) {
    assertEquals(
      resizeErrors(
        await Deno.readTextFile(
          new URL(`../../packages/ui/components/${name}.tsx`, import.meta.url),
        ),
      ),
      [],
      name,
    );
  }
  assert(
    resizeErrors(
      "const right = event.currentTarget.parentElement.getBoundingClientRect().right; width = right - event.clientX;",
    ).length > 0,
  );
  assertEquals(
    resizeErrors(
      "let drag; function down(event) { drag = resizeDrag(width(), event.clientX, -1, 280, 480); } function move(event) { setWidth(drag(event.clientX)); }",
    ),
    [],
  );
  const delegated =
    `import { createResize } from './resize.ts'; const resize = createResize({}); const view = <div {...resize.handlers} />;`;
  assertEquals(resizeErrors(delegated), []);
  for (
    const mutant of [
      delegated.replace("./resize.ts", "./other.ts"),
      delegated.replace("{...resize.handlers}", ""),
      delegated.replace("const resize", "let resize") + "resize = other;",
      delegated.replace("<div", "<div onPointerMove={ownMove}"),
      `function createResize() {} const resize = createResize(); const view = <div {...resize.handlers} />;`,
    ]
  ) assert(resizeErrors(mutant).length > 0, mutant);
});
