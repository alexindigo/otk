// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { uiSources } from "./analysis.ts";
import { surfaceErrors } from "./surface-policy.ts";
import { tokenErrors } from "./tokens.ts";
import { surfaceBypasses, tokenBypasses } from "./bypasses.ts";
surfaceBypasses(surfaceErrors);
tokenBypasses(tokenErrors);

export { surfaceErrors as ownershipErrors, tokenErrors };

async function sources(): Promise<Map<string, string>> {
  return new Map(
    [...(await uiSources())].map((
      [path, source],
    ) => [path.replace(/^packages\/ui\//, ""), source]),
  );
}

Deno.test("overlay owners enforce an internal Surface and normal-flow registered content", async () => {
  assertEquals(surfaceErrors(await sources()), []);
  for (
    const [name, text] of [
      ["components/Bad.tsx", 'import Surface from "./surface/Surface.tsx";'],
      ["components/Bad.tsx", "<dialog />"],
      ["components/Bad.tsx", '<div popover="auto" />'],
      [
        "components/surface/Popover.tsx",
        "onClick={() => panel.togglePopover()}",
      ],
      [
        "components/Bad.css",
        ".card { background: red; border-radius: 10px; box-shadow: 0 0 4px black; }",
      ],
      ["components/Bad.css", "fieldset { background: red; }"],
      [
        "components/surface/Surface.css",
        ".otk-surface-title { position: absolute; }",
      ],
      [
        "components/surface/Popover.css",
        ".otk-popover-panel .child { position: absolute; }",
      ],
      ["components/surface/Menu.css", ".item { position: fixed; }"],
      ["components/surface/Takeover.css", ".item { position: absolute; }"],
      ["components/surface/Dialog.css", ".otk-surface-body { top: 8px; }"],
      [
        "components/surface/Dialog.css",
        ".otk-dialog .child { position: fixed; }",
      ],
      [
        "components/surface/Dialog.css",
        ".otk-dialog[data-size=form] { position: fixed; }",
      ],
      [
        "components/surface/Dialog.css",
        ".otk-dialog[data-dialog=feature] { width: 90vw; }",
      ],
    ]
  ) assert(surfaceErrors(new Map([[name, text]])).length, text);
  for (const owner of ["Dialog", "Popover", "Menu", "Toast", "Takeover"]) {
    assertEquals(
      surfaceErrors(
        new Map([[
          `components/surface/${owner}.tsx`,
          'import Surface from "./Surface.tsx";',
        ]]),
      ),
      [],
    );
  }
  assertEquals(
    surfaceErrors(
      new Map([[
        "components/surface/Dialog.css",
        ".otk-dialog {position: fixed; inset: 0;}",
      ]]),
    ),
    [],
  );
  for (const owner of ["Popover", "Menu", "Toast", "ListPicker"]) {
    assert(
      surfaceErrors(
        new Map([
          [
            "components/Host.tsx",
            `<${owner}><Content /></${owner}>; import Content from "./Content.tsx";`,
          ],
          ["components/Content.tsx", "export default function Content() {}"],
          ["components/Content.css", ".content { position: absolute; }"],
        ]),
      ).length,
      `${owner} content must stay in flow`,
    );
  }
  for (
    const declaration of [
      "position: absolute",
      "position: fixed",
      "top: 8px",
      "margin-top: -8px",
    ]
  ) {
    assert(
      surfaceErrors(
        new Map([
          [
            "features/extension.tsx",
            'dialogs.register({component: Custom}); import Custom from "../components/Custom.tsx";',
          ],
          ["components/Custom.tsx", "export default function Custom() {}"],
          ["components/Custom.css", `.custom { ${declaration}; }`],
        ]),
      ).length,
      declaration,
    );
  }
});

Deno.test("every UI CSS variable resolves to a declared theme or structural token", async () => {
  assertEquals(tokenErrors(await sources()), []);
  assertEquals(
    tokenErrors(new Map([["bad.css", ".bad { color: var(--missing); }"]])),
    ["bad.css: undefined --missing"],
  );
});

Deno.test("only VirtualList's hidden measurement layer may leave overlay flow", () => {
  const fixture = (
    markup = '<div class="otk-virtual-measure" aria-hidden="true" />',
    css =
      ".otk-virtual-measure { position: absolute; visibility: hidden; pointer-events: none; }",
    name = "VirtualList",
  ) =>
    new Map([
      [
        "components/Host.tsx",
        `import Content from "./${name}.tsx"; <Popover><Content /></Popover>;`,
      ],
      [
        `components/${name}.tsx`,
        `export default function Content() { return <div>${markup}</div>; }`,
      ],
      [`components/${name}.css`, css],
    ]);
  assertEquals(surfaceErrors(fixture()), []);
  for (
    const invalid of [
      fixture('<div class="visible" />', ".visible { position: absolute; }"),
      fixture('<div class="otk-virtual-measure" aria-hidden="false" />'),
      fixture('<div class="otk-virtual-measure" />'),
      fixture(
        undefined,
        ".otk-virtual-measure { position: absolute; visibility: visible; pointer-events: none; }",
      ),
      fixture(
        undefined,
        ".otk-virtual-measure { position: absolute; visibility: hidden; pointer-events: auto; }",
      ),
      fixture(undefined, undefined, "Impostor"),
      fixture(
        '<><div class="otk-virtual-measure" aria-hidden="true" /><div class="otk-virtual-measure" /></>',
      ),
    ]
  ) assert(surfaceErrors(invalid).length, JSON.stringify([...invalid]));
  for (const condition of ["@media print", "@supports (display: grid)"]) {
    const conditional = fixture(
      undefined,
      `.otk-virtual-measure { position: absolute; visibility: visible; pointer-events: none; }
      ${condition} { .otk-virtual-measure { visibility: hidden; } }`,
    );
    assert(surfaceErrors(conditional).length, condition);
  }
});

Deno.test("A12 surface analysis accepts native nested flow, sticky offsets and decorative lamps", () => {
  assertEquals(
    surfaceErrors(
      new Map([
        [
          "components/Host.tsx",
          'import { Body as Content } from "./Body.tsx"; export function Host() { return <Popover><Content /></Popover>; }',
        ],
        [
          "components/Body.tsx",
          'export function Body() { return <div class="body"><span class="lamp" aria-hidden="true" /><table><tfoot><tr><th>Total</th></tr></tfoot></table></div>; }',
        ],
        [
          "components/Body.css",
          `
      .body { display: flex; .row { display: grid; align-items: center; } }
      :is(thead, tfoot) th { position: sticky; }
      tfoot th { bottom: 0; }
      .lamp { background: red; border-radius: 8px; box-shadow: 0 0 4px black; }
    `,
        ],
      ]),
    ),
    [],
  );
});

Deno.test("A12 token availability accepts real ancestor and animation consumer scopes", () => {
  assertEquals(
    tokenErrors(
      new Map([
        [
          "components/Light.tsx",
          'export function Light() { return <div class="scope"><span class="lamp" /></div>; }',
        ],
        [
          "components/Light.css",
          `
      .scope { --ink: red; }
      .lamp { color: var(--ink); --lamp-color: red; animation: pulse 1s; }
      @keyframes pulse { to { color: var(--lamp-color); } }
    `,
        ],
      ]),
    ),
    [],
  );
});
