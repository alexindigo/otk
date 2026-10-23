// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";
type Scan = (source: string) => string[];
type Files = (files: ReadonlyMap<string, string>) => string[];

const rejects = (errors: string[], source: string) =>
  assert(errors.length > 0, `Bypass accepted: ${source}`);

export function presenterBypasses(presenterErrors: Scan): void {
  for (
    const source of [
      "function ToolPath(props) { /* relativeTarget(props.path, props.directory) */ return <span>{props.path}</span>; }",
      "function ToolPath(props) { if (false) relativeTarget(props.path, props.directory); return <span>{props.path}</span>; }",
      "function ToolPath(props) { relativeTarget(props.path, props.directory); return <span>{props.path}</span>; }",
    ]
  ) {
    Deno.test(`A12 P5#10 presenter invocation must reach the rendered value ${source}`, () =>
      rejects(presenterErrors(source), source));
  }
}
export function layoutBypasses(layoutOwnerErrors: Scan): void {
  for (
    const source of [
      'export function register(rpc, prefs) { /* prefs.set("shellLayout", { ...prefs.get().shellLayout, ...patch }) */ rpc.register("layout.patch", {handler: (_, patch) => prefs.set("shellLayout", patch)}); }',
      'export function register(rpc, prefs) { if (false) prefs.set("shellLayout", { ...prefs.get().shellLayout, ...patch }); rpc.register("layout.patch", {handler: (_, patch) => prefs.set("shellLayout", patch)}); }',
    ]
  ) {
    Deno.test(`A12 P5#10 unused layout spelling cannot replace handler ownership ${source}`, () =>
      rejects(layoutOwnerErrors(source), source));
  }
}

export function dependencyBypasses(scan: Scan): void {
  for (
    const expression of [
      "`${await import('@otk/ui')}`",
      "`${() => import(name)}`",
      "`${`${import('@otk/ui')}`}`",
    ]
  ) {
    Deno.test(`A12 P5#8 import inside ${expression}`, () => {
      const source = `const value = ${expression};`;
      rejects(scan(source), source);
    });
  }
}

export function tabBypasses(tabErrors: Scan): void {
  Deno.test("A12 P5#9 renamed tab markers cannot hide a menu", () => {
    const source =
      'function Tabs() { return <div role="tablist" class="new-tabs"><Menu trigger="More" /></div>; }';
    rejects(tabErrors(source), source);
  });
}
export function readinessBypasses(readinessErrors: Scan): void {
  for (
    const source of [
      "async function submit() { let draft = change(current => current); }",
      "async function submit() { /* await ctx.ready() */ let draft = change(current => current); }",
      "async function submit() { if (false) { await ctx.ready(); } let draft = change(current => current); }",
    ]
  ) {
    Deno.test(`A12 P5#9 readiness ${source}`, () =>
      rejects(readinessErrors(source), source));
  }
}

export function resizeBypasses(resizeErrors: Scan): void {
  for (
    const source of [
      "// resizeDrag(\nconst move = event => setWidth(event.clientX);",
      "function down(event) { resizeDrag(width(), event.clientX, 1, 200, 360); } function move(event) { setWidth(event.clientX); }",
    ]
  ) {
    Deno.test(`A12 P5#9 unused gesture ${source}`, () =>
      rejects(resizeErrors(source), source));
  }
}

export function contextBypasses(contextErrors: Scan): void {
  for (
    const source of [
      'el["addEventListener"]("contextmenu", handler);',
      'const eventName = "contextmenu"; el.addEventListener(eventName, handler);',
      'const {addEventListener: listen} = el; listen("contextmenu", handler);',
    ]
  ) {
    Deno.test(`A12 P5#12 listener ${source}`, () =>
      rejects(contextErrors(source), source));
  }
}

export function pathBypasses(pathErrors: Scan): void {
  for (
    const source of [
      "const {path: target} = props.call; return <span>{target}</span>;",
      "const operation = props.call; return <span>{operation.path}</span>;",
      'import Label from "./ToolPath.tsx"; return <Label path={props.call.path} />;',
    ]
  ) {
    Deno.test(`A12 P5#12 path ${source}`, () =>
      rejects(pathErrors(source), source));
  }
}

export function pickerBypasses(pickerErrors: Scan): void {
  Deno.test("A12 P5#11 new adapter files cannot duplicate composer ownership", () => {
    const source =
      "const queue = Promise.resolve(); function choose(draft) { return chooseModel(draft, model); }";
    rejects(pickerErrors(source), source);
  });
}
export function shellBypasses(shellErrors: Scan): void {
  Deno.test("A12 P5#11 arrow constructors cannot duplicate the shared owner", () => {
    const source =
      "export const createSessionActions = (options) => ({prompt() {}});";
    rejects(shellErrors(source), source);
  });
}
export function resultBypasses(resultErrors: Scan): void {
  Deno.test("A12 P5#12 expression-valued summary class cannot hide repeated operations", () => {
    const source =
      'return <div class={"otk-tool-summary"}>Read {call.path}</div>;';
    rejects(resultErrors(source), source);
  });
}

export function typographyBypasses(visualErrors: Scan): void {
  for (
    const css of [
      ".x { font-family: Arial; }",
      ".x { font: 400 8px/12px var(--font-ui); }",
      ".x { font-size: 6pt; }",
    ]
  ) {
    Deno.test(`A12 P5#12 typography ${css}`, () =>
      rejects(visualErrors(css), css));
  }
}

export function focusBypasses(focusErrors: Scan): void {
  Deno.test("A12 P5#12 alternate outline syntax cannot paint a layout wrapper", async () => {
    const css = await Deno.readTextFile(
      new URL("../../packages/ui/theme.css", import.meta.url),
    );
    rejects(
      focusErrors(
        css +
          ":focus-visible { outline-style: solid; outline-width: 3px; outline-color: red; }",
      ),
      "longhand outline",
    );
  });
}

export function surfaceBypasses(ownershipErrors: Files): void {
  for (
    const style of [
      [
        "named import",
        'import { Content as Child } from "./Content.tsx"; return <Popover><Child /></Popover>;',
      ],
      [
        "wrapper import",
        'import { Content as Child } from "./barrel.ts"; return <Popover><Child /></Popover>;',
      ],
    ]
  ) {
    Deno.test(`A12 P5#13 ${style[0]} follows overlay descendants`, () => {
      rejects(
        ownershipErrors(
          new Map([
            ["components/Host.tsx", style[1]],
            [
              "components/barrel.ts",
              'export { Content } from "./Content.tsx";',
            ],
            [
              "components/Content.tsx",
              'export function Content() { return <div class="content" />; }',
            ],
            ["components/Content.css", ".content { position: absolute; }"],
          ]),
        ),
        style[0],
      );
    });
  }
  Deno.test("A12 P5#13 split declarations cannot hide card paint", () => {
    const css =
      ".card { background: red; } .card { border-radius: 8px; } .card { box-shadow: 0 0 4px black; }";
    rejects(ownershipErrors(new Map([["components/Bad.css", css]])), css);
  });
  Deno.test("A12 P5#13 split classes cannot hide composed card paint", () => {
    rejects(
      ownershipErrors(
        new Map([
          [
            "components/Bad.tsx",
            'export default function Bad() { return <div class="fill rounded shadow" />; }',
          ],
          [
            "components/Bad.css",
            ".fill { background: red; } .rounded { border-radius: 8px; } .shadow { box-shadow: 0 0 4px black; }",
          ],
        ]),
      ),
      "composed card classes",
    );
  });
}
export function tokenBypasses(tokenErrors: Files): void {
  for (
    const [name, definition] of [
      ["comment", "/* --ghost: red; */"],
      ["unrelated selector", ".other { --ghost: red; }"],
    ]
  ) {
    Deno.test(`A12 P5#14 ${name} cannot define a consumer token`, () => {
      rejects(
        tokenErrors(
          new Map([[
            "components/Bad.css",
            `${definition} .consumer { color: var(--ghost); }`,
          ]]),
        ),
        definition,
      );
    });
  }
  Deno.test("A12 P5#14 unimported stylesheet cannot define a consumer token", () => {
    rejects(
      tokenErrors(
        new Map([
          ["components/Unused.css", ":root { --ghost: red; }"],
          ["components/Bad.css", ".consumer { color: var(--ghost); }"],
        ]),
      ),
      "unimported stylesheet",
    );
  });
}
