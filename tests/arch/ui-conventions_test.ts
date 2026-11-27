// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { FailurePresenter } from "../../packages/client/failures.ts";
import { productionSources, Source, sourceInventory } from "./analysis.ts";
import { nodes, property, type t } from "./syntax.ts";
import {
  cssTree,
  outOfFlow,
  rules,
  selectorAlternatives,
  variables,
} from "./styles.ts";
import { composerInTranscriptErrors } from "./composer-placement.ts";
import { composerHeaderErrors } from "./composer-header.ts";
import { textLayoutErrors } from "./text-layout.ts";
import { containerChromeErrors } from "./container-chrome.ts";
import { messageHeaderClockErrors } from "./message-clocks.ts";
import { terminalRunErrors } from "./terminal-run.ts";
import { foldRecords } from "../../packages/client/record-folds.ts";
import { PreferenceRegistry } from "../../packages/protocol/prefs.ts";
import { registerTranscriptPreferences } from "../../packages/protocol/preferences/transcript.ts";
import {
  codeSeparatorErrors,
  styleBoundaryErrors,
} from "./style-boundaries.ts";

const popoverCSS = "packages/ui/components/surface/Popover.css";

function stopGlyphErrors(files: ReadonlyMap<string, string>): string[] {
  return [...files].flatMap(([path, text]) => {
    if (
      !path.startsWith("packages/ui/") ||
      path === "packages/ui/components/Prompt.tsx" ||
      path === "packages/ui/components/ChromeIcons.tsx" ||
      !text.includes("StopIcon")
    ) return [];
    const source = new Source(text, path);
    return source.all.some((node) =>
        node.type === "ImportSpecifier" &&
          property(node.imported) === "StopIcon" ||
        (node.type === "MemberExpression" ||
            node.type === "OptionalMemberExpression" ||
            node.type === "JSXMemberExpression") &&
          property(node.property) === "StopIcon"
      )
      ? [
        `${path}: the stop square belongs to the composer; use TerminateButton for individual work`,
      ]
      : [];
  });
}

Deno.test("UI convention: only the composer uses the stop square", async () => {
  const square = 'import { StopIcon as Square } from "./ChromeIcons.tsx";';
  assertEquals(
    stopGlyphErrors(
      new Map([
        ["packages/ui/components/Prompt.tsx", square],
        ["packages/ui/components/RunningCommand.tsx", square],
        [
          "packages/ui/components/LiveWork.tsx",
          'import * as Icons from "./ChromeIcons.tsx"; <Icons.StopIcon />;',
        ],
        [
          "packages/ui/components/TerminateButton.tsx",
          'import { CloseIcon } from "./ChromeIcons.tsx"; <CloseIcon />;',
        ],
        [
          "packages/ui/components/Subagents.tsx",
          'import TerminateButton from "./TerminateButton.tsx"; <TerminateButton />;',
        ],
      ]),
    ).map((error) => error.split(":")[0]),
    [
      "packages/ui/components/RunningCommand.tsx",
      "packages/ui/components/LiveWork.tsx",
    ],
  );
  assertEquals(stopGlyphErrors(await productionSources()), []);
});

Deno.test("UI convention: one terminal run path", async () => {
  const surface = "packages/ui/terminal/ghostty/surface.ts";
  assertEquals(
    terminalRunErrors(
      new Map([
        [
          surface,
          'this.core.encodePaste(text) + "\\r"; function pasteAndSubmit() {}',
        ],
        [
          "packages/ui/features/terminal/Terminal.tsx",
          "pane.renderer!.submit(); new TerminalRuns();",
        ],
        [
          "packages/ui/features/code-blocks.tsx",
          'box.runs.request("x", "submit");',
        ],
      ]),
    ).length,
    5,
  );
  assertEquals(
    terminalRunErrors(
      new Map([
        [
          surface,
          'this.sendInput(() => this.core.encodePaste(text)); this.sendInput(() => "\\r");',
        ],
        [
          "packages/ui/features/terminal/model.ts",
          "function runTarget() { return { paste: (text) => pane.renderer!.paste(text) }; }",
        ],
        ["packages/ui/features/prompt/shell.ts", "ctx.submit(action);"],
      ]),
    ),
    [],
  );
  assertEquals(terminalRunErrors(await productionSources()), []);
});

Deno.test("UI convention: container chrome stays off item collections", async () => {
  const tabs = "packages/ui/components/Tabs.tsx";
  const view = "packages/ui/Fixture.tsx";
  const rejected = new Map([
    [tabs, 'interface TabStripProps { "titleAction"?: () => unknown }'],
    [
      view,
      `<Show when={list.length}><Tabs label="T" tabs={t()} selected={0} onSelect={f} actions={() => <B/>} /></Show>;
      <TabStrip leading={<B/>} trailing={<B/>} header={<B/>} titleAction={<B/>} />;`,
    ],
  ]);
  assertEquals(containerChromeErrors(rejected).length, 6);
  const accepted = new Map([
    [tabs, "interface TabStripProps { closeAction?: (id: string) => unknown }"],
    [
      view,
      `<Surface title={<h2>T</h2>} titleAction={<B/>}>
      <TabStrip tabs={t()} selected={0} onSelect={f} closeAction={close} />
      <TabPanels tabs={t()} selected={0} />
    </Surface>;`,
    ],
  ]);
  assertEquals(containerChromeErrors(accepted), []);
  assertEquals(containerChromeErrors(await productionSources()), []);
});

Deno.test("UI convention: container chrome is not gated on item counts", async () => {
  const view = "packages/ui/Fixture.tsx";
  const shell = "packages/ui/components/LiveWork.tsx";
  const rejected = new Map([
    [
      shell,
      `export default function LiveWork() {
      return <Show when={presence.mounted}><Popover /></Show>;
    }`,
    ],
    [
      view,
      `<Show when={helpers()?.ids.length ? helpers() : undefined}>
      {(p) => <Menu label="S">x</Menu>}
    </Show>;
    <Show when={shells()?.count}><LiveWork shells={s()} /></Show>;
    (ready && list.size > 0) && <div><Popover /></div>;
    list?.length ? <Dialog /> : <Takeover />;`,
    ],
  ]);
  assertEquals(
    containerChromeErrors(rejected).map((error) => error.split(": ").at(-1)),
    ["Menu", "LiveWork", "Popover", "Dialog", "Takeover"].map((name) =>
      `${name} must not be count-gated`
    ),
  );
  const accepted = new Map([[
    view,
    `<Surface title={<h2>T</h2>} titleAction={<A/>}>
    <Show when={list().length} fallback={<Empty/>}>{rows}</Show>
    <For each={rows()}>{(r) => <TerminateButton name={r().title} action={stop(r())} />}</For>
    {list.length && <Rows />}
  </Surface>;
  <Show when={presence.mounted}><Menu label="S">x</Menu></Show>;`,
  ]]);
  assertEquals(containerChromeErrors(accepted), []);
  assertEquals(containerChromeErrors(await productionSources()), []);
});

// Offsets may use the containing edge and spacing tokens, not other boxes'
// dimensions. Follow custom property aliases so naming a calculation doesn't
// make a positional relationship structural.
function arithmeticOffsetErrors(files: ReadonlyMap<string, string>): string[] {
  const styles = [...files].flatMap(([path, css]) =>
    rules(css).map((rule) => ({ path, ...rule }))
  );
  const definitions = new Map<string, string[]>();
  for (const { declarations } of styles) {
    for (const [prop, value] of declarations) {
      if (!prop.startsWith("--")) continue;
      const values = definitions.get(prop) ?? [];
      values.push(value);
      definitions.set(prop, values);
    }
  }
  const spacing =
    /^(?:--otk-(?:unit|scale)|--space-\d+|--(?:overlay|popover|lane)-gutter)$/;
  const calculated = (value: string, visited: ReadonlySet<string>): boolean => {
    let offset = false;
    cssTree.walk(
      cssTree.parse(value.replace(/\s*!important$/, ""), { context: "value" }),
      (node) => {
        if (node.type !== "Function" || node.name.toLowerCase() !== "calc") {
          return;
        }
        const expression = cssTree.generate(node);
        let lengths = 0;
        cssTree.walk(node, (part) => {
          if (part.type === "Dimension") lengths++;
          if (
            part.type === "Percentage" || part.type === "Function" &&
              /^anchor(?:-size)?$/.test(part.name)
          ) offset = true;
        });
        if (
          lengths > 1 ||
          variables(expression).some(({ name }) => !spacing.test(name))
        ) {
          offset = true;
        }
      },
    );
    if (offset) return true;
    return variables(value).some(({ name }) =>
      !spacing.test(name) && !visited.has(name) &&
      definitions.get(name)?.some((next) =>
        calculated(next, new Set([...visited, name]))
      )
    );
  };
  return styles.flatMap(({ path, selector, declarations }) =>
    [...declarations].filter(([prop, value]) =>
      /^(?:top|bottom|left|right|inset(?:-(?:block|inline)(?:-(?:start|end))?)?)$/
        .test(prop) &&
      calculated(value, new Set())
    ).map(([prop, value]) => `${path}: ${selector}: ${prop}: ${value}`)
  );
}

Deno.test("UI convention: text sizes are intrinsic and scripts do not own CSS widths", async () => {
  const css = "packages/ui/Example.css", tsx = "packages/ui/Example.tsx";
  assertEquals(
    textLayoutErrors(
      new Map([
        [
          css,
          ":root{--crumb-min:12ch}.some-title{min-width:min(100%,var(--crumb-min))}.some-name{width:80px}.copy{width:var(--copy)}",
        ],
        [
          tsx,
          `const style = el.style;
      style.setProperty("--copy", el.scrollWidth + "px");
      el.style.inlineSize = el.clientWidth + "px";
      el.style.cssText = "color: red; min-width: 3px";
      <span style={{ width: measured + "px" }} />;`,
        ],
      ]),
    ).length,
    6,
  );
  assertEquals(
    textLayoutErrors(
      new Map([
        [
          css,
          ".some-title{min-width:0;min-inline-size:calc-size(min-content,min(size,12ch));max-width:60ch}.some-icon{width:32px}",
        ],
        [
          tsx,
          `el.style.setProperty("--accent", color); canvas.width = pixels;
      <span style={{ color }} />;`,
        ],
      ]),
    ),
    [],
  );
  assertEquals(textLayoutErrors(await productionSources()), []);
});

Deno.test("UI convention: positional offsets do not reconstruct other boxes", async () => {
  const productionCSS = new Map(
    [...await productionSources()].filter(([path]) =>
      /^(?:packages\/ui|web\/src)\/.*\.css$/.test(path)
    ),
  );
  assertEquals(arithmeticOffsetErrors(productionCSS), []);
  for (
    const value of [
      "calc(100% + 12px)",
      "calc(42px - 18px / 2)",
      "max(0px, calc(var(--dock-height) + var(--space-2)))",
      "var(--position)",
    ]
  ) {
    assertEquals(
      arithmeticOffsetErrors(
        new Map([
          [
            "tokens.css",
            ":root{--position:var(--clearance);--clearance:calc(var(--dock-size) - 4px)}",
          ],
          ["stack.css", `.stack { inset-block-end: ${value} }`],
        ]),
      ).length,
      1,
      value,
    );
  }
  assertEquals(
    arithmeticOffsetErrors(
      new Map([[
        "example.css",
        ".lane{display:flex;align-items:center;gap:var(--space-2)}" +
        ".overlay{inset:0;bottom:var(--overlay-gutter);max-block-size:calc(100vh - var(--space-2))}" +
        ".popover{top:100%;margin-top:var(--space-2)}" +
        ".icon{inset-block-end:calc(4 * var(--otk-unit))}",
      ]]),
    ),
    [],
  );
});

function popoverPlacementErrors(path: string, text: string): string[] {
  if (!path.startsWith("packages/ui/") || !path.endsWith(".css")) return [];
  return rules(text).flatMap(({ selector, declarations }) => {
    for (const [name, value] of declarations) {
      if (
        path !== popoverCSS &&
        (/^(?:anchor-name|anchor-scope|position-anchor)$/.test(name) ||
          /\banchor(?:-size)?\(/.test(value))
      ) return [`${path}: ${selector}`];
      if (
        path === popoverCSS && selector.includes(".otk-popover-bounds-end") &&
        /\d(?:vw|vh)\b/.test(value)
      ) return [`${path}: ${selector}`];
    }
    return [];
  });
}

Deno.test("2.86: popover placement only in the Popover owner", async () => {
  for (const [path, text] of await productionSources()) {
    assertEquals(popoverPlacementErrors(path, text), []);
  }
  assert(
    popoverPlacementErrors(
      "packages/ui/components/Fixture.css",
      ".region{anchor-scope:--test}",
    ).length,
  );
  assert(
    popoverPlacementErrors(popoverCSS, ".otk-popover-bounds-end{right:1vw}")
      .length,
  );
});

const headerFixture = () =>
  new Map([
    [
      "ComposerTakeovers.css",
      ".otk-composer-live-slot{display:flex;gap:var(--space-4)}",
    ],
    ["LiveCount.css", ".otk-live-count{gap:var(--space-2)}"],
    ["LiveWork.css", ".otk-live-work-trigger{display:flex}"],
    [
      "LiveLink.css",
      ".otk-live-link{flex:1 1 0;min-inline-size:var(--space-6)}",
    ],
    ["Subagents.css", ".otk-subagent-row{grid-template-columns:subgrid}"],
  ]);

Deno.test("UI convention: composer header spacing and link borrow tokens and one owner", async () => {
  const files = new Map(
    await Promise.all(
      [...headerFixture().keys(), "LiveLink.tsx"].map(async (file) => {
        const contents = await Deno.readTextFile(
          `packages/ui/components/${file}`,
        ).catch((err) => {
          if (err instanceof Deno.errors.NotFound) return "";
          throw err;
        });
        return [file, contents] as const;
      }),
    ),
  );
  assertEquals(composerHeaderErrors(files), []);
});

Deno.test("UI convention: composer header rejects duplicated spacing and positional patches", () => {
  const files = headerFixture();
  files.set("LiveWork.css", ".otk-live-work-trigger{gap:var(--space-2)}");
  files.set(
    "LiveLink.css",
    files.get("LiveLink.css") +
      ".otk-live-link-light{position:absolute}@keyframes otk-live-link-travel{to{left:0}}",
  );
  files.set(
    "Subagents.css",
    files.get("Subagents.css") +
      ".otk-subagent-row > .otk-subagent-time{margin-inline-start:1em}",
  );
  assertEquals(composerHeaderErrors(files), [
    ".otk-live-work-trigger: trigger must not own lamp spacing",
    ".otk-live-link-light: link must stay in flow",
    "otk-live-link-travel: unexpected left",
    ".otk-subagent-row>.otk-subagent-time: row layout must not use margin-inline-start",
  ]);
});

Deno.test("UI convention: composer header accepts in-flow owner styles", () => {
  assertEquals(composerHeaderErrors(headerFixture()), []);
});

Deno.test("UI convention: breadcrumb trails use one compact overflow row", async () => {
  const component = await Deno.readTextFile(
    "packages/ui/components/TaskTrail.tsx",
  );
  const overflow = await Deno.readTextFile(
    "packages/ui/components/OverflowRow.css",
  );
  const chrome = await Deno.readTextFile(
    "packages/ui/components/ProjectTabs.css",
  );
  const source = new Source(component);
  assert(
    source.all.some((node) =>
      node.type === "JSXOpeningElement" &&
      source.name(node.name) === "OverflowRow" && node.attributes.some((attr) =>
        attr.type === "JSXAttribute" && property(attr.name) === "singleLine"
      )
    ),
  );
  assert(
    /\.otk-overflow-row\.is-single-line\s+\.otk-overflow-items\s*\{\s*flex-wrap:\s*nowrap/
      .test(overflow),
  );
  assert(
    (await Deno.readTextFile("packages/ui/components/OverflowRow.tsx"))
      .includes("<ScrollRegion"),
  );
  const header =
    rules(chrome).find((rule) => rule.selector === ".otk-breadcrumb-row")!
      .declarations;
  assertEquals(header.get("display"), "grid");
  assertEquals(
    header.get("grid-template-columns"),
    "minmax(min-content,1fr) minmax(0,max-content)",
  );
  assert(!component.includes("props.model.helpers"));
  const subagents = await Deno.readTextFile(
    "packages/ui/components/Subagents.tsx",
  );
  assert(subagents.includes("props.helpers"));
  assert(subagents.includes("helperDisposition("));
  assert(subagents.includes("<TimeText"));
  assert(subagents.includes("<Menu"));
});

Deno.test("UI convention: framed composer rows borrow their owner's inline inset", async () => {
  const errors = (css: string, rows: readonly string[], owner: string) =>
    rules(css).flatMap((rule) =>
      selectorAlternatives(rule.selector).some((selector) =>
          rows.some((row) => selector.endsWith(`.${row}`))
        )
        ? [...rule.declarations].filter(([prop, value]) =>
          /^(padding|padding-inline(?:-start|-end)?|padding-left|padding-right)$/
            .test(prop) &&
          value !== "0" && value !== "0px" &&
          (prop === "padding" ||
            !(value === `var(${owner})` || value.startsWith(`var(${owner},`)))
        ).map(([prop]) => `${rule.selector}: independent ${prop}`)
        : []
    );
  const read = (name: string) =>
    Deno.readTextFile(`packages/ui/components/${name}.css`);
  for (
    const [file, rows, owner] of [
      [
        "ComposerTakeovers",
        ["otk-composer-activity"],
        "--composer-content-inset",
      ],
      ["Prompt", ["otk-prompt"], "--composer-content-inset"],
      ["ComposerNotice", ["otk-composer-notice"], "--composer-content-inset"],
      ["TakeoverHeader", ["otk-takeover-header"], "--surface-slot-inset"],
      ["ActivityGroup", ["otk-record-group-heading"], "--tree-content-inset"],
      [
        "RevertGroup",
        ["otk-revert-label", "otk-revert-heading-content"],
        "--tree-content-inset",
      ],
      ["surface/Surface", [
        "otk-surface-title",
        "otk-surface-body",
        "otk-surface-actions",
      ], "--surface-slot-inset"],
    ] as const
  ) {
    assertEquals(errors(await read(file), rows, owner), [], file);
  }
  const dock = rules(await read("ComposerTakeovers"));
  const owners = [...await productionSources()].filter(([path]) =>
    path.endsWith(".css")
  ).flatMap(([path, css]) =>
    rules(css).filter((rule) =>
      rule.declarations.has("--composer-content-inset")
    ).map((rule) => `${path}:${rule.selector}`)
  );
  assertEquals(owners, [
    "packages/ui/components/ComposerTakeovers.css:.otk-composer-dock",
  ]);
  assertEquals(
    dock.find((r) => r.selector === ".otk-composer-dock")?.declarations.get(
      "--composer-content-inset",
    ),
    "var(--space-4)",
  );
  assertEquals(
    dock.find((r) => r.selector === ".otk-composer-activity")?.declarations.get(
      "padding-inline",
    ),
    "var(--composer-content-inset)",
  );
  const row = ["aligned-row"];
  assertEquals(
    errors(".aligned-row { padding-inline: var(--owner); }", row, "--owner"),
    [],
  );
  assertEquals(
    errors(".aligned-row { padding-block: var(--space-3); }", row, "--owner"),
    [],
  );
  assertEquals(errors(".aligned-row { padding: 0; }", row, "--owner"), []);
  for (
    const declaration of [
      "padding: 0 var(--space-4)",
      "padding-inline: var(--space-4)",
      "padding-left: 20px",
      "padding-inline-end: 1em",
      "padding-inline: var(--owner-bypass)",
    ]
  ) {
    assert(
      errors(`:is(.aligned-row, .another) { ${declaration}; }`, row, "--owner")
        .length > 0,
      declaration,
    );
  }
});

Deno.test("UI convention: informational connection actions keep the shared feedback row", async () => {
  const source = await Deno.readTextFile(
    "packages/ui/components/ConnectionStatus.tsx",
  );
  assert(source.includes("subgrid={props.subgrid && !!feedback().failure}"));
});

Deno.test("UI convention: transcript rhythm supplies the tail gap without a second inset", async () => {
  const css = rules(
    await Deno.readTextFile("packages/ui/components/SessionView.css"),
  );
  assertEquals(
    css.find((rule) => rule.selector === ".otk-message-flow")?.declarations
      .get("--message-gap"),
    "var(--space-6)",
  );
  const padding = css.filter((rule) => rule.selector === ".otk-messages")
    .flatMap((rule) => [...rule.declarations.keys()])
    .filter((name) => /^padding(?:-block(?:-end)?|-bottom)?$/.test(name));
  assertEquals(padding, []);
});

Deno.test("UI convention: every composer notice occupies the shared flow track", async () => {
  const violations = (css: string) =>
    rules(css).filter((rule) =>
      rule.selector.includes(".otk-composer-feedback") &&
      outOfFlow(rule.declarations)
    ).map((rule) => rule.selector);
  assertEquals(
    violations(".otk-composer-feedback { position: relative; }"),
    [],
  );
  for (
    const layout of [
      "position: absolute",
      "position: fixed",
      "margin-top: -1px",
    ]
  ) {
    assertEquals(
      violations(`.otk-composer-feedback.is-runtime { ${layout}; }`),
      [
        ".otk-composer-feedback.is-runtime",
      ],
    );
  }
  assertEquals(
    violations(
      await Deno.readTextFile(
        "packages/ui/components/ComposerTakeovers.css",
      ),
    ),
    [],
  );
  for (const name of ["ComposerTakeovers", "SessionView"]) {
    assert(
      !(await Deno.readTextFile(`packages/ui/components/${name}.tsx`))
        .includes("noticeFlow"),
    );
  }
});

Deno.test("UI convention: syntax enhancement cannot publish user-action failures in source", async () => {
  const failures = (text: string) =>
    new Source(text).all.flatMap((node) =>
      node.type === "ImportDeclaration"
        ? node.specifiers.map((part) =>
          part.type === "ImportSpecifier"
            ? part.imported.type === "Identifier"
              ? part.imported.name
              : part.imported.value
            : node.source.value.endsWith("/FeedbackStatus.tsx")
            ? "FeedbackStatus"
            : part.local.name
        )
        : []
    ).filter((name) =>
      ["FeedbackStatus", "failureValue", "errorFeedback"].includes(name)
    );
  assertEquals(
    failures(await Deno.readTextFile("packages/ui/components/Code.tsx")),
    [],
  );
  assertEquals(
    failures('import {failureValue as diagnose} from "@otk/client";'),
    ["failureValue"],
  );
  assertEquals(
    failures('import {normalizeError as diagnose} from "@otk/protocol";'),
    [],
  );
  assertEquals(failures('import FeedbackStatus from "./FeedbackStatus.tsx";'), [
    "FeedbackStatus",
  ]);
  assertEquals(failures('import Status from "./FeedbackStatus.tsx";'), [
    "FeedbackStatus",
  ]);
  assert(
    (await Deno.readTextFile("packages/ui/highlight/client.ts")).includes(
      "Syntax highlighting diagnostic:",
    ),
  );
});

Deno.test("UI convention: folded record counts are neutral metadata, not per-kind hidden rows", async () => {
  const source = await Deno.readTextFile(
    "packages/ui/components/RecordKinds.tsx",
  );
  assert(source.includes('variant="meta"'));
  assert(source.includes("<Disclosure"));
  assert(!/step-start|step-finish|opencode-v1|display:\s*none/.test(source));
  const values = foldRecords([1, 2], () => ({
    kindLabel: "fixture",
    title: "Unrelated producer",
    layout: "row",
    tone: "normal",
    category: "record",
    fold: true,
    summary: { kind: "fixture", noun: "fact", plural: "facts" },
  }), () => false);
  assertEquals(values.visible, []);
  assertEquals(values.folds[0].label, "2 facts");
});

Deno.test("UI convention: transcript disclosure defaults name their action", () => {
  const registry = new PreferenceRegistry();
  registerTranscriptPreferences(registry);
  assertEquals(
    registry.settings("transcript").filter((entry) =>
      entry.key !== "expandCompaction" &&
      !/^Expand .+ by default$/.test(entry.label)
    ).map((entry) => entry.key),
    [],
  );
});

Deno.test("UI convention: component styles never target another component's internals, including every disclosure caller", async () => {
  const files = new Map(
    [...(await productionSources())].filter(([p]) =>
      /^(?:packages\/ui\/|web\/src\/)/.test(p)
    ),
  );
  assertEquals(styleBoundaryErrors(files), []);
});

Deno.test("UI convention: composer-owned content never mounts in the transcript flow", async () => {
  const files = await productionSources();
  assertEquals(composerInTranscriptErrors(files), []);
  const fixture = (body: string) =>
    new Map([
      [
        "Notice.tsx",
        "export function Notice(){return <ComposerNoticeRow>Copy</ComposerNoticeRow>}",
      ],
      [
        "View.tsx",
        `import {Notice as CopyNotice} from "./Notice.tsx"; const view=${body};`,
      ],
    ]);
  assert(
    composerInTranscriptErrors(
      fixture('<div class="otk-message-flow"><CopyNotice /></div>'),
    ).length > 0,
  );
  assert(
    composerInTranscriptErrors(
      fixture('<div class="otk-message-flow"><ComposerNotice /></div>'),
    ).length > 0,
  );
  assertEquals(
    composerInTranscriptErrors(
      fixture('<div class="otk-composer-dock"><CopyNotice /></div>'),
    ),
    [],
  );
  assertEquals(
    composerInTranscriptErrors(
      fixture('<div class="otk-message-flow"><ActivityGroup /></div>'),
    ),
    [],
  );
});

Deno.test("UI convention: global failure notifications do not add a layout-pushing banner", async () => {
  const source = new Source(
    await Deno.readTextFile("packages/ui/shell/Shell.tsx"),
  );
  const banners = source.all.filter((node) =>
    node.type === "JSXAttribute" &&
    node.name.name === "class" &&
    /\botk-global-error\b/.test(source.string(node.value) ?? "")
  );
  assertEquals(banners, []);
});

Deno.test("UI convention: separators built in ports, templates and code use the presentation owner", async () => {
  const failures: string[] = [];
  for (const [path, text] of await productionSources()) {
    if (
      /^(?:packages\/(?:client|ui)\/|web\/src\/)/.test(path) &&
      /\.tsx?$/.test(path)
    ) failures.push(...codeSeparatorErrors(path, text));
  }
  assertEquals(failures, []);
});

Deno.test("UI convention: style isolation follows native emitters, aliases, all disclosure callers and public slots", () => {
  const base = new Map([
    [
      "A.tsx",
      'import "./A.css"; export const A = () => <div class="a"><Child class="slot" /></div>;',
    ],
    [
      "B.tsx",
      'import "./B.css"; export const B = () => <div class="b"><span class="b-icon" /></div>;',
    ],
    ["B.css", ".b { display: grid } .b-icon { width: 1em }"],
    ["A.css", ".a { display: grid } .slot { grid-column: 2 }"],
  ]);
  assertEquals(styleBoundaryErrors(base), []);
  for (
    const selector of [
      ".a .b-icon",
      ".b",
      ":is(.b-icon,.b)",
      ".a { & > .b-icon",
    ]
  ) {
    const changed = new Map(base);
    changed.set(
      "A.css",
      selector.includes("{")
        ? `${selector} { padding: 0 } }`
        : `${selector} { padding: 0 }`,
    );
    assert(styleBoundaryErrors(changed).length > 0, selector);
  }
  for (const classInput of ['"custom"', "{borrowed}"]) {
    for (
      const declaration of [
        "grid-template-columns: 1fr",
        "padding-inline: 2px",
        "gap: 0",
        "display: flex",
      ]
    ) {
      const changed = new Map(base);
      changed.set(
        "A.tsx",
        `import Toggle from "./DisclosureToggle.tsx"; import "./A.css"; const borrowed="custom"; const view=<Toggle class=${classInput} />;`,
      );
      changed.set("A.css", `.custom { ${declaration} }`);
      assert(
        styleBoundaryErrors(changed).length > 0,
        `${classInput}: ${declaration}`,
      );
    }
  }
  const disclosure = new Map(base);
  disclosure.set(
    "packages/ui/components/DisclosureToggle.tsx",
    'import "./DisclosureToggle.css"; const toggle = <button class="otk-disclosure-toggle otk-tree-toggle" />;',
  );
  disclosure.set(
    "packages/ui/components/DisclosureToggle.css",
    ".otk-disclosure-toggle.otk-tree-toggle { padding: 0 }",
  );
  assertEquals(styleBoundaryErrors(disclosure), []);
  disclosure.set("A.css", ".otk-tree-toggle { padding: 0 }");
  assert(styleBoundaryErrors(disclosure).length > 0);
  disclosure.set("A.css", ".a { display: grid }");
  disclosure.set(
    "packages/ui/theme.css",
    ".otk-disclosure-icon { padding: 0 }",
  );
  assert(styleBoundaryErrors(disclosure).length > 0);
});

Deno.test("UI convention: code separator rejection includes templates, concatenation and joins, not file paths", () => {
  for (
    const code of [
      "const value = `${task} / ${session}`;",
      'const value = task + " / " + session;',
      'const value = values.join(" / ");',
      "const value = `${agent} · ${time}`;",
    ]
  ) assert(codeSeparatorErrors("port.ts", code).length > 0, code);
  for (
    const code of [
      "const value = `${directory}/${file}`;",
      "const value = metaList([agent, time]);",
      "const value = {task, session};",
    ]
  ) assertEquals(codeSeparatorErrors("port.ts", code), []);
});

type Rule =
  | "clock"
  | "icons"
  | "ellipsis"
  | "meta-tone"
  | "masks"
  | "native"
  | "alignment"
  | "disclosure"
  | "duration"
  | "time-text"
  | "meta-list"
  | "failure-signal"
  | "presentation"
  | "failure-wording"
  | "settings-name"
  | "list-order"
  | "sidebar-row"
  | "message-footer";
const owners: Record<Rule, string> = {
  clock:
    "Local date/time formatting belongs to Clock (including precise records)",
  icons:
    "Real icons only: use an icon component or StateShape, never text glyphs",
  ellipsis: "Interface progress/truncation uses ASCII three dots, never U+2026",
  "meta-tone":
    "Metadata is plain ChromeMeta; error tone belongs to FailureSignal, icons or count badges",
  masks:
    "Structure over paint masks: end Tree guides at their junction/artwork cell",
  native:
    "Decision 54: use DisclosureToggle, Select/ListPicker and Popover, not browser-native widgets",
  alignment:
    "Structural alignment: use shared grid/subgrid tracks and intrinsic sizing, not compensating offsets/ratios",
  disclosure:
    "DisclosureToggle owns tracks, gap and padding; consumers supply only its gutter input",
  duration:
    "One duration format: use the client duration owner, never a local elapsed formatter",
  "time-text":
    "Time values render through TimeText; attributes may use the owner's text",
  "meta-list":
    "One metadata join: use ChromeMeta's metaList, not separate flex-item separators",
  "failure-signal":
    "One failure signal: use FailureSignal, not a red chip outline",
  presentation:
    "FailurePresentation is produced by the client presenter, never reconstructed by a view or fixture",
  "failure-wording":
    "Failure reasons and next steps are plain; storage APIs, byte counts and quotas belong in Details",
  "settings-name":
    "One surface name: navigation says Settings / servers, matching Settings",
  "list-order":
    "Decision 60: list order uses saved positions or creation, never activity, recency or state",
  "sidebar-row":
    "SidebarRow owns artwork and shrinkable labels; Tree owns lamp lanes and depth; no local offsets or overlapping selection",
  "message-footer":
    "D21: MessageFooter owns persistent time/actions; message metadata is never hover-only",
};
const containsStringType = (node: t.Node): boolean => {
  if (node.type === "TSStringKeyword") return true;
  return Object.values(node).some((value) =>
    (Array.isArray(value) ? value : [value]).some((child) =>
      child && typeof child === "object" && "type" in child &&
      containsStringType(child as t.Node)
    )
  );
};
const elementName = (node: t.JSXOpeningElement) =>
  node.name.type === "JSXIdentifier" ? node.name.name : "";

Deno.test("UI convention: task tabs render their lamp in the shared leading slot", async () => {
  const path = "packages/ui/components/ProjectTabs.tsx";
  const source = new Source(await Deno.readTextFile(path), path);
  const selection = source.all.find((node): node is t.JSXOpeningElement =>
    node.type === "JSXOpeningElement" &&
    elementName(node) === "SelectionContent"
  );
  assert(selection);
  const leading = selection.attributes.find((attr): attr is t.JSXAttribute =>
    attr.type === "JSXAttribute" && property(attr.name) === "leading"
  )?.value;
  assert(leading?.type === "JSXExpressionContainer");
  assert(leading.expression.type === "JSXElement");
  assertEquals(elementName(leading.expression.openingElement), "StatusLight");
});

Deno.test("UI convention: unowned compact controls retain native geometry", async () => {
  const geometry = (css: string) =>
    rules(css).flatMap((rule) =>
      /^input\[type=["']?(?:checkbox|radio|range|color|file|button|submit|reset|image)\b/i
          .test(rule.selector)
        ? [...rule.declarations.keys()].filter((key) =>
          /^(?:inline-size|block-size|width|height|flex|margin|padding)(?:-|$)/
            .test(key)
        )
        : []
    );
  assertEquals(geometry("input[type=radio] { accent-color: red; }"), []);
  assertEquals(geometry("input[type=radio] { margin: 4px 3px 3px 4px; }"), [
    "margin",
  ]);
  assertEquals(geometry(".otk-control input[type=radio] { margin: 0; }"), []);
  assertEquals(
    geometry(
      await Deno.readTextFile(
        new URL("../../packages/ui/theme.css", import.meta.url),
      ),
    ),
    [],
  );
});

Deno.test("UI convention: one composer destination row uses muted nonwrapping metadata and structural alignment", async () => {
  const source = await Deno.readTextFile(
    new URL(
      "../../packages/ui/components/ComposerTakeovers.tsx",
      import.meta.url,
    ),
  );
  const syntax = new Source(source, "ComposerTakeovers.tsx");
  const target = syntax.all.find((node) =>
    node.type === "JSXOpeningElement" &&
    elementName(node) === "span" && node.attributes.some((attr) =>
      attr.type === "JSXAttribute" &&
      property(attr.name) === "class" && attr.value?.type === "StringLiteral" &&
      attr.value.value.includes("otk-composer-target")
    )
  );
  assert(target?.type === "JSXOpeningElement");
  for (const part of ["otk-composer-task", "otk-composer-destination"]) {
    assert(source.includes(`class="${part} otk-control-label"`));
  }
  assert(
    target.attributes.some((attr) =>
      attr.type === "JSXAttribute" && property(attr.name) === "title"
    ),
  );
  const css = rules(
    await Deno.readTextFile(
      new URL(
        "../../packages/ui/components/ComposerTakeovers.css",
        import.meta.url,
      ),
    ),
  );
  const row =
    css.find((rule) =>
      rule.selector === ".otk-composer-activity-line" && !rule.condition
    )!.declarations;
  assertEquals(row.get("display"), "flex");
  assertEquals(row.get("align-items"), "center");
  const route =
    css.find((rule) =>
      rule.selector === ".otk-composer-route" && !rule.condition
    )!.declarations;
  assertEquals(route.get("display"), "flex");
  assertEquals(route.get("align-items"), "center");
  const label =
    css.find((rule) => rule.selector === ".otk-composer-target")!.declarations;
  assertEquals(label.get("min-inline-size"), "0");
  assertEquals(label.get("display"), "grid");
  assertEquals(label.get("flex"), "0 1 auto");
  assert(
    !css.some((rule) =>
      [...rule.declarations.keys()].some((key) =>
        key.startsWith("--live-count-")
      )
    ),
  );
  assert(
    !css.some((rule) => rule.declarations.has("--live-link-display")),
  );
  assert(
    css.some((rule) =>
      rule.condition.includes("@container composer-activity") &&
      rule.selector === ".otk-composer-activity-line" &&
      rule.declarations.get("flex-wrap") === "wrap"
    ),
  );
});

Deno.test("UI convention: overflow More keeps the first control track when required items reflow", async () => {
  const anchored = (text: string) => {
    const more = rules(text).find((rule) =>
      rule.selector === ".otk-overflow-more"
    )?.declarations;
    return more?.get("align-self") === "start" &&
      more.get("min-block-size") === "var(--row-compact)" &&
      more.get("align-items") === "center";
  };
  assert(
    !anchored(".otk-overflow-more { display: flex; align-items: center; }"),
  );
  assert(
    anchored(
      ".otk-overflow-more { display: flex; align-items: center; align-self: start; min-block-size: var(--row-compact); }",
    ),
  );
  assert(
    anchored(
      await Deno.readTextFile(
        new URL(
          "../../packages/ui/components/OverflowRow.css",
          import.meta.url,
        ),
      ),
    ),
  );
});

/** Syntax-aware checks are exported so their reject/accept cases stay executable.
 * Owner exceptions name real responsibilities, never individual violations. */
export function conventionErrors(
  rule: Rule,
  path: string,
  text: string,
): string[] {
  const errors: string[] = [];
  const fail = (where: string) =>
    errors.push(`${path}: ${where}: ${owners[rule]}`);
  if (rule === "ellipsis" && /\u2026|\\u2026|\\u\{2026\}/iu.test(text)) {
    fail("U+2026 in source");
  }
  if (path.endsWith(".css")) {
    for (const { selector, declarations: d } of rules(text)) {
      if (
        rule === "time-text" &&
        path !== "packages/ui/components/TimeText.css" &&
        timeClass.test(selector)
      ) fail(selector);
      if (
        rule === "message-footer" &&
        /otk-(?:message-(?:footer|details|action)|user-meta|created-time|timeline-(?:clock|actions))/
          .test(selector) &&
        (d.get("visibility") === "hidden" || d.get("display") === "none" ||
          /^(?:0|0\.0+)$/.test(d.get("opacity") ?? ""))
      ) fail(selector);
      if (
        rule === "sidebar-row" &&
        /otk-(?:sidebar-(?:row|slot|lamp|icon|label|selection)|project-(?:row|open|name-line|marker|attention))/
          .test(selector)
      ) {
        if (
          [...d].some(([key, value]) =>
            key === "position" && ["absolute", "fixed"].includes(value) ||
            /^(?:margin|inset|top|left|right|bottom)/.test(key) &&
              /(^|[\s(])-\d/.test(value)
          )
        ) fail(selector);
        if (
          path !== "packages/ui/components/SidebarRow.css" &&
          (d.has("grid-template-columns") ||
            /otk-project-(?:row|open)\b/.test(selector) &&
              [...d.keys()].some((key) =>
                /^(?:padding(?:-.+)?|margin(?:-.+)?|gap|column-gap|display)$/
                  .test(key)
              ) ||
            /sidebar-(?:row|slot|lamp|icon|label)/.test(selector) &&
              [...d.keys()].some((key) =>
                /^(?:width|inline-size|min-width|min-inline-size|padding|gap|column-gap|display)$/
                  .test(key)
              ))
        ) fail(selector);
      }
      if (
        rule === "ellipsis" &&
        [...d.values()].some((value) => value.includes("\u2026"))
      ) fail(selector);
      if (
        rule === "icons" &&
        /icon|glyph|toggle|close|marker|disclosure/.test(selector) &&
        /^['"][^'"\s]+['"]$/.test(d.get("content") ?? "")
      ) fail(selector);
      if (
        rule === "meta-tone" &&
        /meta|reply-start|record-group-(?:count|time|failures)|record-summary|elapsed/
          .test(
            selector,
          ) &&
        ((d.has("color") &&
          !["var(--otk-fg-3)", "inherit"].includes(d.get("color")!)) ||
          d.has("font-weight") &&
            !["400", "inherit", "normal"].includes(d.get("font-weight")!))
      ) fail(selector);
      if (
        rule === "masks" &&
        /tree-(?:toggle|junction|icon-art)|disclosure/.test(selector) &&
        // A whole interactive target may tint on hover; the glyph and its
        // slot still cannot cover a line with paint.
        selector !== ".otk-disclosure-button:hover" &&
        ["fill", "background", "background-color"].some((key) =>
          d.has(key) && !["none", "transparent"].includes(d.get(key)!)
        )
      ) fail(selector);
      if (
        rule === "alignment" &&
        /connection-status.*has-failure/.test(selector) &&
        [...d].some(([key, value]) =>
          /gutter|inset|margin|padding/.test(key) && value !== "0" &&
          value !== "0px"
        )
      ) fail(selector);
      if (
        rule === "alignment" && /send-failure/.test(selector) &&
        (d.get("justify-self") === "stretch" ||
          [...d].some(([key, value]) =>
            /^(?:inline-size|width)$/.test(key) && value !== "fit-content" &&
            value !== "auto"
          ))
      ) fail(selector);
      if (
        rule === "alignment" && /live-work-popover/.test(selector) &&
        [...d].some(([key, value]) =>
          /^(?:width|inline-size)$/.test(key) &&
          /\b(?:vw|px)\b|\d+(?:vw|px)/.test(value)
        )
      ) fail(selector);
      if (
        rule === "alignment" && /failure-heading/.test(selector) &&
        /\d+%/.test(d.get("max-inline-size") ?? "")
      ) fail(selector);
      if (
        rule === "disclosure" &&
        !/^packages\/ui\/components\/Disclosure(?:Toggle)?\.css$/.test(path) &&
        /\.otk-disclosure-[\w-]+/.test(selector)
      ) fail(selector);
      if (
        rule === "failure-signal" &&
        /chip.*(?:has-error|is-error)/.test(selector) &&
        [...d].some(([key, value]) =>
          /border|outline|box-shadow/.test(key) &&
          !["none", "0", "transparent"].includes(value)
        )
      ) fail(selector);
    }
    return errors;
  }
  const source = new Source(text, path);
  if (rule === "duration" || rule === "time-text") {
    if (path !== "packages/client/format.ts") {
      for (const node of source.all) {
        if (legacyTimeBinding(node, rule === "time-text")) {
          fail(`retired time formatter on line ${node.loc?.start.line}`);
        }
      }
    }
    if (rule === "duration" && path !== "packages/client/format.ts") {
      for (const node of localDurations(source)) {
        fail(`local duration on line ${node.loc?.start.line}`);
      }
    }
    if (rule === "time-text") {
      for (const node of source.all) {
        if (
          ((node.type === "TSPropertySignature" ||
            node.type === "ObjectProperty") &&
            property(node.key) === "visitText") ||
          ((node.type === "MemberExpression" ||
            node.type === "OptionalMemberExpression") &&
            property(node.property) === "visitText") ||
          (node.type === "JSXAttribute" && property(node.name) === "visitText")
        ) {
          fail(`retired project visit text on line ${node.loc?.start.line}`);
        }
        if (
          path !== "packages/ui/components/TimeText.tsx" &&
          ((node.type === "StringLiteral" && timeClass.test(node.value)) ||
            (node.type === "TemplateElement" && timeClass.test(node.value.raw)))
        ) {
          fail(`presenter-owned class on line ${node.loc?.start.line}`);
        }
        if (
          path.startsWith("packages/ui/") && path.endsWith(".tsx") &&
          node.type === "JSXExpressionContainer" && jsxChild(source, node) &&
          showsTime(source, node.expression)
        ) {
          fail(`unpresented time on line ${node.loc?.start.line}`);
        }
      }
    }
    return errors;
  }
  const modulePath = (specifier: string) =>
    specifier.startsWith(".")
      ? new URL(specifier, new URL(path, "https://otk.invalid/")).pathname
        .slice(1)
      : specifier;
  if (rule === "message-footer") {
    errors.push(...messageHeaderClockErrors(new Map([[path, text]])));
    for (const node of source.all) {
      if (node.type !== "JSXOpeningElement" || !source.live(node)) continue;
      const imported = source.imported(node.name);
      if (
        source.attr(node, "data-message-command") &&
        path !== "packages/ui/components/MessageActions.tsx"
      ) fail("handwritten message action control");
      if (
        modulePath(imported?.module ?? "").endsWith("/MessageActions.tsx") &&
        !(path === "packages/ui/components/MessageFooter.tsx" ||
          path === "packages/ui/components/CodeBlock.tsx" &&
            source.string(source.attr(node, "kind")) === "code")
      ) fail("content actions outside MessageFooter or CodeBlock");
      if (
        source.string(source.attr(node, "class"))?.includes(
          "otk-message-footer",
        ) && path !== "packages/ui/components/MessageFooter.tsx"
      ) fail("handwritten message footer");
    }
  }
  if (rule === "sidebar-row") {
    const openings = source.all.filter((node): node is t.JSXOpeningElement =>
      node.type === "JSXOpeningElement" && source.live(node)
    );
    if (path === "packages/ui/components/ProjectInbox.tsx") {
      if (
        !openings.some((node) =>
          modulePath(source.imported(node.name)?.module ?? "") ===
            "packages/ui/components/SidebarRow.tsx"
        )
      ) fail("project rows bypass SidebarRow");
      for (
        const node of openings.filter((node) =>
          source.imported(node.name)?.name === "SectionHeader"
        )
      ) {
        if (
          !node.attributes.some((attr) =>
            attr.type === "JSXAttribute" && property(attr.name) === "sidebar" &&
            attr.value === null
          )
        ) fail("section header bypasses sidebar tracks");
      }
    }
    if (path !== "packages/ui/components/SidebarRow.tsx") {
      for (const node of openings) {
        if (
          node.attributes.some((attr) =>
            attr.type === "JSXAttribute" &&
            ["class", "className"].includes(property(attr.name) ?? "") &&
            /\botk-sidebar-(?:row|slot|lamp|icon|label)\b/.test(
              source.string(attr.value) ?? "",
            )
          )
        ) {
          fail("handwritten sidebar slot");
        }
      }
    }
  }
  const iconFunctions = new Set<t.Node>();
  for (const node of source.all) {
    const value =
      node.type === "ObjectProperty" && property(node.key) === "icon"
        ? node.value
        : node.type === "JSXAttribute" && property(node.name) === "icon"
        ? node.value
        : undefined;
    if (!value) continue;
    const resolved = source.value(value);
    if (
      resolved?.type === "ArrowFunctionExpression" ||
      resolved?.type === "FunctionExpression"
    ) iconFunctions.add(resolved);
    else if (resolved?.type === "Identifier") {
      const binding = source.binding(resolved.name, resolved);
      for (const declaration of source.all) {
        if (
          declaration.type === "FunctionDeclaration" && declaration.id &&
          source.binding(declaration.id.name, declaration.id) === binding
        ) iconFunctions.add(declaration);
      }
    }
  }
  const componentIcon = (input: t.Node): boolean => {
    const value = source.value(input);
    if (!value) return false;
    const imported = source.imported(value);
    if (imported) {
      return [
            "packages/ui/components/ChromeIcons.tsx",
            "packages/ui/components/tools/ToolIcons.tsx",
          ].includes(modulePath(imported.module)) &&
          /Icon$/.test(imported.name) ||
        imported.module === "@otk/ui" && /Icon$/.test(imported.name);
    }
    if (
      value.type === "MemberExpression" ||
      value.type === "OptionalMemberExpression"
    ) return true; // Typed borrowed renderer/image input; its producer is checked independently.
    if (value.type === "LogicalExpression") {
      return componentIcon(value.left) && componentIcon(value.right);
    }
    if (value.type === "ConditionalExpression") {
      return componentIcon(value.consequent) && componentIcon(value.alternate);
    }
    if (
      value.type === "NullLiteral" ||
      value.type === "Identifier" && value.name === "undefined"
    ) return true;
    const fn = (value.type === "ArrowFunctionExpression" ||
        value.type === "FunctionExpression")
      ? value
      : value.type === "Identifier"
      ? [...iconFunctions].find((node) =>
        node.type === "FunctionDeclaration" && node.id &&
        source.binding(node.id.name, node.id) ===
          source.binding(value.name, value)
      )
      : undefined;
    if (fn) {
      return source.all.some((node) =>
        source.function(node) === fn && node.type === "JSXOpeningElement" &&
        source.live(node) &&
        (elementName(node) === "svg" ||
          [
            "packages/ui/components/Icon.tsx",
            "packages/ui/components/ChromeIcons.tsx",
            "packages/ui/components/StateShape.tsx",
          ].includes(modulePath(source.imported(node.name)?.module ?? "")))
      ) ||
        ("body" in fn && (fn.body as t.Node).type === "NullLiteral");
    }
    if (value.type === "Identifier") {
      const binding = source.binding(value.name, value);
      return !!binding && binding.scope.type !== "Program" &&
        source.all.some((candidate) =>
          candidate.type === "Identifier" &&
          source.binding(candidate.name, candidate) === binding &&
          candidate.typeAnnotation?.type === "TSTypeAnnotation" &&
          candidate.typeAnnotation.typeAnnotation.type === "TSFunctionType"
        );
    }
    return false;
  };
  const imageProperty = (node: t.TSPropertySignature): boolean => {
    const owner = source.function(node);
    if (
      !owner || node.typeAnnotation?.typeAnnotation.type !== "TSStringKeyword"
    ) return false;
    let parameter: t.Node | undefined = source.parent.get(node);
    while (
      parameter && parameter !== owner && parameter.type !== "Identifier"
    ) parameter = source.parent.get(parameter);
    if (parameter?.type !== "Identifier") return false;
    const binding = source.binding(parameter.name, parameter);
    const references = source.all.filter((item): item is t.MemberExpression =>
      item.type === "MemberExpression" && property(item.property) === "icon" &&
      source.access(item.object)?.binding === binding
    );
    const images = references.filter((item) => {
      const expression = source.parent.get(item),
        attr = expression && source.parent.get(expression);
      const element = attr && source.parent.get(attr);
      return attr?.type === "JSXAttribute" && property(attr.name) === "src" &&
        element?.type === "JSXOpeningElement" && elementName(element) === "img";
    });
    return images.length > 0 && references.every((item) => {
      const expression = source.parent.get(item),
        parent = expression && source.parent.get(expression);
      return expression?.type !== "JSXExpressionContainer" ||
        parent?.type === "JSXAttribute";
    });
  };
  if (
    rule === "settings-name" &&
    source.all.some((node) =>
      /Settings \/ sidecars/.test(staticText(source, node) ?? "")
    )
  ) {
    fail("navigation label");
  }
  for (const node of source.all) {
    if (rule === "failure-wording") {
      const inputs = node.type === "ObjectProperty" &&
          ["reason", "recovery", "actionLabel"].includes(
            property(node.key) ?? "",
          )
        ? [node.value]
        : node.type === "CallExpression" && source.name(node.callee) === "fail"
        ? node.arguments.slice(1, 4)
        : [];
      for (const input of inputs) {
        if (
          source.all.some((child) =>
            child.start! >= input.start! && child.end! <= input.end! &&
            /localStorage|\bbytes\b|\b\d+\s*MB\b/i.test(
              child.type === "StringLiteral"
                ? child.value
                : child.type === "TemplateElement"
                ? child.value.raw
                : "",
            )
          )
        ) {
          fail(`technical failure wording on line ${node.loc?.start.line}`);
        }
      }
    }
    if (rule === "list-order") {
      const orderingOwner =
        /packages\/client\/(?:stable-order|tabs|inbox|project-projection|server-resources|session-tree|index)\.ts$/
          .test(path);
      const dynamic = (input: t.Node): boolean => {
        const resolved = source.value(input) ?? input;
        return source.all.some((child) =>
          child.start! >= resolved.start! && child.end! <= resolved.end! &&
          (child.type === "Identifier" || child.type === "StringLiteral") &&
          /activity|recency|status|stateBand|urgency|priority|rank|timeUpdated|lastVisit|^state$/i
            .test(
              child.type === "Identifier" ? child.name : child.value,
            )
        );
      };
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        ["sort", "toSorted", "order"].includes(
          property(node.callee.property) ?? "",
        ) &&
        (orderingOwner ||
          /tasks|projects|checkouts|tabs|siblings/i.test(
            source.name(node.callee.object) ?? "",
          )) &&
        node.arguments.slice(property(node.callee.property) === "order" ? 1 : 0)
          .some((arg) => dynamic(arg))
      ) {
        fail(`dynamic list ordering on line ${node.loc?.start.line}`);
      }
      if (
        orderingOwner && node.type === "ObjectProperty" &&
        ["order", "position", "created"].includes(property(node.key) ?? "") &&
        dynamic(node.value)
      ) {
        fail(`dynamic order facts on line ${node.loc?.start.line}`);
      }
    }
    if (
      rule === "presentation" &&
      !["packages/client/failures.ts", "packages/client/failure-features.ts"]
        .includes(path) &&
      node.type === "ObjectExpression" &&
      (["heading", "reason", "tone"].every((key) =>
        node.properties.some((p) =>
          p.type === "ObjectProperty" && property(p.key) === key
        )
      ) ||
        node.properties.some((p) =>
            p.type === "SpreadElement" &&
            /\.failure$/.test(source.name(p.argument) ?? "")
          ) &&
          node.properties.some((p) =>
            p.type === "ObjectProperty" &&
            ["heading", "reason", "tone", "target", "kind"].includes(
              property(p.key) ?? "",
            )
          ))
    ) {
      fail(`hand-authored failure on line ${node.loc?.start.line}`);
    }
    if (
      rule === "native" && node.type === "CallExpression" &&
      source.name(node.callee)?.endsWith(".createElement") &&
      ["details", "summary", "select"].includes(
        source.string(node.arguments[0]) ?? "",
      )
    ) fail(`native widget on line ${node.loc?.start.line}`);
    if (
      rule === "ellipsis" &&
      ((node.type === "StringLiteral" || node.type === "JSXText") &&
          node.value.includes("\u2026") ||
        node.type === "TemplateElement" &&
          node.value.cooked?.includes("\u2026"))
    ) fail(`line ${node.loc?.start.line}`);
    if (rule === "clock" && path !== "packages/ui/components/Clock.tsx") {
      if (
        (node.type === "CallExpression" || node.type === "NewExpression") &&
        node.callee.type === "MemberExpression"
      ) {
        const method = property(node.callee.property);
        const options = node.arguments.map((arg) =>
          text.slice(arg.start!, arg.end!)
        ).join(" ");
        // Numeric locale formatting is not a date formatter. Date options and
        // Date-valued receivers distinguish it without exempting file paths.
        const receiver = source.value(node.callee.object);
        if (
          ["toLocaleDateString", "toLocaleTimeString", "DateTimeFormat"]
            .includes(method ?? "") ||
          method === "toLocaleString" &&
            (/year|month|day|hour|minute|second|timeZone/i.test(options) ||
              receiver?.type === "NewExpression" &&
                source.name(receiver.callee) === "Date" ||
              receiver?.type === "Identifier" &&
                source.all.some((candidate) =>
                  candidate.type === "Identifier" &&
                  candidate.name === receiver.name &&
                  candidate.typeAnnotation &&
                  source.binding(candidate.name, candidate) ===
                    source.binding(receiver.name, receiver) &&
                  /\bDate\b/.test(
                    text.slice(
                      candidate.typeAnnotation.start!,
                      candidate.typeAnnotation.end!,
                    ),
                  )
                ))
        ) fail(`line ${node.loc?.start.line}`);
      }
    }
    if (rule === "icons") {
      const iconValue =
        node.type === "ObjectProperty" && property(node.key) === "icon"
          ? node.value
          : node.type === "JSXAttribute" && property(node.name) === "icon"
          ? node.value
          : undefined;
      if (iconValue && !componentIcon(iconValue)) {
        fail(`unproven icon component on line ${node.loc?.start.line}`);
      }
      if (
        node.type === "TSPropertySignature" && property(node.key) === "icon" &&
        node.typeAnnotation && containsStringType(node.typeAnnotation) &&
        !imageProperty(node)
      ) fail(`icon type on line ${node.loc?.start.line}`);
      if (
        (node.type === "ObjectProperty" && property(node.key) === "icon" &&
          source.string(node.value) !== undefined) ||
        (node.type === "JSXAttribute" && property(node.name) === "icon" &&
          source.string(node.value) !== undefined)
      ) fail(`icon value on line ${node.loc?.start.line}`);
      if (
        (node.type === "StringLiteral" || node.type === "JSXText") &&
        /^[\s\[\]✓•⌕◇↳↓☑◐×]+$/.test(node.value) &&
        /[✓•⌕◇↳↓☑◐×]/.test(node.value)
      ) fail(`glyph on line ${node.loc?.start.line}`);
      if (
        node.type === "JSXElement" &&
        (elementName(node.openingElement) === "text" ||
          node.openingElement.attributes.some((attr) =>
              attr.type === "JSXAttribute" &&
              property(attr.name) === "aria-hidden" &&
              source.string(attr.value) === "true"
            ) &&
            node.children.some((child) =>
              child.type === "JSXText" && /^[xv]$/i.test(child.value.trim())
            ))
      ) {
        fail(`text artwork on line ${node.loc?.start.line}`);
      }
      const iconFunction = iconFunctions.has(node)
        ? node as t.Function
        : node.type === "FunctionDeclaration" &&
            /Icon$/.test(node.id?.name ?? "")
        ? node
        : node.type === "VariableDeclarator" &&
            node.id.type === "Identifier" && /Icon$/.test(node.id.name) &&
            (node.init?.type === "ArrowFunctionExpression" ||
              node.init?.type === "FunctionExpression")
        ? node.init
        : node.type === "ObjectProperty" && property(node.key) === "icon" &&
            node.value.type === "ArrowFunctionExpression"
        ? node.value
        : undefined;
      if (
        iconFunction &&
        (source.string(iconFunction.body) !== undefined ||
          source.all.some((child) =>
            source.function(child) === iconFunction &&
            (child.type === "JSXText" && !!child.value.trim() ||
              child.type === "ReturnStatement" &&
                source.string(child.argument) !== undefined)
          ))
      ) {
        fail(`text icon component on line ${iconFunction.loc?.start.line}`);
      }
    }
    if (rule === "native" && node.type === "JSXOpeningElement") {
      const name = elementName(node);
      if (["details", "summary", "select"].includes(name)) {
        fail(`<${name}> on line ${node.loc?.start.line}`);
      }
      if (
        (name === "Dynamic" &&
          ["details", "summary", "select"].includes(
            source.string(source.attr(node, "component")) ?? "",
          )) ||
        (name === "input" &&
          source.string(source.attr(node, "type")) === "checkbox" &&
          path !== "packages/ui/components/Checkbox.tsx")
      ) {
        fail(`native widget on line ${node.loc?.start.line}`);
      }
      // Preview surfaces have their own hover/focus detail; title elsewhere is
      // still the documented full-value/name affordance, not a second preview.
      const previewOwner = source.all.some((item) =>
        item.type === "TSPropertySignature" &&
        property(item.key) === "preview" &&
        source.function(item) === source.function(node)
      );
      const nativeTarget = node.attributes.some((attr) =>
        attr.type === "JSXAttribute" && property(attr.name) === "popovertarget"
      );
      const title = node.attributes.find((attr) =>
        attr.type === "JSXAttribute" && property(attr.name) === "title"
      );
      if (
        name === "button" && previewOwner && nativeTarget &&
        title?.type === "JSXAttribute"
      ) {
        const value = title.value?.type === "JSXExpressionContainer"
          ? title.value.expression
          : undefined;
        const guarded = value?.type === "ConditionalExpression" &&
          value.test.type === "MemberExpression" &&
          property(value.test.property) === "preview" &&
          source.access(value.test.object)?.binding ===
            source.access((source.function(node) as t.Function).params[0])
              ?.binding &&
          value.consequent.type === "Identifier" &&
          value.consequent.name === "undefined";
        if (!guarded) {
          fail(`native preview tooltip on line ${node.loc?.start.line}`);
        }
      }
    }
    if (
      rule === "meta-list" &&
      path !== "packages/ui/components/ChromeMeta.tsx" &&
      node.type === "JSXElement" &&
      (source.name(node.openingElement.name) === "ChromeMeta" ||
        source.string(source.attr(node.openingElement, "class"))?.includes(
          "otk-chrome-meta",
        )) &&
      source.all.some((child) =>
        child.start! > node.start! && child.end! < node.end! &&
        (child.type === "JSXText" && child.value.trim() === "·" ||
          child.type === "TemplateElement" && child.value.raw.includes("·") ||
          child.type === "JSXExpressionContainer" && (() => {
              const value = source.value(child.expression);
              return source.string(value)?.trim() === "·" ||
                value?.type === "TemplateLiteral" &&
                  value.quasis.some((q) => q.value.raw.includes("·"));
            })())
      )
    ) {
      fail(`separator on line ${node.loc?.start.line}`);
    }
    if (
      rule === "meta-list" && path !== "packages/client/format.ts" &&
      path !== "packages/ui/components/ChromeMeta.tsx" &&
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      property(node.callee.property) === "join" &&
      staticText(source, node.arguments[0]) === " · "
    ) {
      fail(`local metadata join on line ${node.loc?.start.line}`);
    }
  }
  return errors;
}

const retiredTimeNames = new Set([
  "duration",
  "humanDuration",
  "relativeTime",
  "visitTime",
  "visitText",
  "runningWorkElapsed",
]);
const timeFormatters = new Set(["elapsed", "age", "remaining"]);
const timeClass = /(?:^|[^\w-])otk-time(?:-(?:part|value|unit))?(?![\w-])/;
function legacyTimeBinding(node: t.Node, checkImports: boolean): boolean {
  const retired = (name: t.Node | null | undefined) =>
    !!name && retiredTimeNames.has(property(name) ?? "");
  if (node.type === "ImportDeclaration" && checkImports) {
    return node.specifiers.some((spec) =>
      retired(spec.local) ||
      spec.type === "ImportSpecifier" && retired(spec.imported)
    );
  }
  if (node.type !== "ExportNamedDeclaration") return false;
  const declaration = node.declaration;
  return node.specifiers.some((spec) =>
    retired(spec.exported) ||
    spec.type === "ExportSpecifier" && retired(spec.local)
  ) ||
    (declaration?.type === "VariableDeclaration" &&
      declaration.declarations.some(({ id }) => retired(id))) ||
    (declaration?.type === "FunctionDeclaration" && retired(declaration.id));
}

const unitText = /^(?:d|h|m|s|ms|sec|seconds|min|minutes|hours|days)\b/;
function jsxChild(source: Source, node: t.Node): boolean {
  const parent = source.parent.get(node);
  return parent?.type === "JSXElement" || parent?.type === "JSXFragment";
}
function* localDurations(source: Source) {
  const converted = (input: t.Node) =>
    [...nodes(source.value(input) ?? input)].some((node) => {
      if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        property(node.callee.property) === "toFixed"
      ) return true;
      if (node.type !== "BinaryExpression" || node.operator !== "/") {
        return false;
      }
      const divisor = source.value(node.right);
      return divisor?.type === "NumericLiteral" &&
        [1000, 60_000, 3_600_000, 86_400_000].includes(divisor.value);
    });
  for (const node of source.all) {
    if (
      node.type === "TemplateLiteral" &&
      node.expressions.some((expr, i) =>
        unitText.test(node.quasis[i + 1].value.raw.trimStart()) &&
        converted(expr)
      )
    ) yield node;
    if (
      node.type === "BinaryExpression" && node.operator === "+" &&
      unitText.test(source.string(node.right)?.trimStart() ?? "") &&
      converted(node.left)
    ) yield node;
    if (
      node.type === "JSXExpressionContainer" && jsxChild(source, node) &&
      converted(node.expression)
    ) {
      const parent = source.parent.get(node) as t.JSXElement | t.JSXFragment;
      const next = parent.children[parent.children.indexOf(node) + 1];
      if (next?.type === "JSXText" && unitText.test(next.value.trimStart())) {
        yield node;
      }
    }
  }
}

function showsTime(source: Source, input: t.Node): boolean {
  const namesTime = (node: t.Node) => {
    const imported = source.imported(node);
    return imported
      ? timeFormatters.has(imported.name)
      : node.type === "Identifier" &&
        !source.access(node) && timeFormatters.has(node.name);
  };
  const typedTime = (node: t.Node): boolean => {
    const annotation = node.type === "Identifier" && node.typeAnnotation;
    if (!annotation || annotation.type !== "TSTypeAnnotation") return false;
    const type = annotation.typeAnnotation;
    return type.type === "TSTypeReference" &&
      (source.imported(type.typeName)?.name === "TimeText" ||
        property(type.typeName) === "TimeText" ||
        property(type.typeName) === "ReturnType" &&
          !!type.typeParameters?.params.some((param) =>
            param.type === "TSTypeQuery" && namesTime(param.exprName)
          ));
  };
  const isTime = (expr: t.Node) => {
    const binding = source.access(expr)?.binding;
    const node = source.value(expr);
    return node?.type === "CallExpression" && namesTime(node.callee) ||
      !!binding &&
        source.all.some((id) =>
          id.type === "Identifier" && typedTime(id) &&
          source.binding(id.name, id) === binding
        );
  };
  const value = source.value(input) ?? input;
  if (isTime(value)) return true;
  if (
    value.type === "MemberExpression" ||
    value.type === "OptionalMemberExpression"
  ) {
    return (value.computed
          ? source.string(value.property)
          : property(value.property)) === "text" && isTime(value.object);
  }
  if (value.type === "ConditionalExpression") {
    return showsTime(source, value.consequent) ||
      showsTime(source, value.alternate);
  }
  if (value.type === "LogicalExpression") {
    return showsTime(source, value.right) ||
      (value.operator !== "&&" && showsTime(source, value.left));
  }
  return false;
}

Deno.test("UI convention: duration catches JSX suffixes, rounding and renamed helpers", () => {
  for (
    const [path, text] of [
      [
        "packages/ui/Fixture.tsx",
        "<span>Next attempt in {Math.max(0, Math.ceil((next - now) / 1000))}s</span>",
      ],
      [
        "packages/client/Fixture.ts",
        "export const runningWorkElapsed = elapsed;",
      ],
      [
        "packages/client/Fixture.ts",
        'const format = (x: number) => x.toFixed(1) + "s";',
      ],
      [
        "core/Fixture.ts",
        "const format = (x: number) => `${Math.round(x / 86_400_000)} days`;",
      ],
    ]
  ) assert(conventionErrors("duration", path, text).length, text);
  assertEquals(
    conventionErrors(
      "duration",
      "core/Fixture.ts",
      "const seconds = (ms: number) => Math.ceil(ms / 1000);",
    ),
    [],
  );
});

Deno.test("UI convention: TimeText owns time value markup, not attribute prose", () => {
  const path = "packages/ui/Fixture.tsx";
  for (
    const text of [
      "<span>{elapsed(x).text}</span>",
      "<span>{age(at, now)}</span>",
      'import { elapsed as format } from "@otk/client"; const time = format(x); const view = <span>{time.text}</span>;',
      'import { elapsed } from "@otk/client"; function View(time: ReturnType<typeof elapsed>) { return <span>{time.text}</span>; }',
      'export { elapsed as duration } from "@otk/client";',
      'import { relativeTime as age } from "@otk/client";',
      'import { visitText } from "@otk/client";',
      "interface Project { visitText?: string }",
      'const row = { visitText: "now" };',
      'const text = row?.["visitText"];',
      "const { visitText } = row;",
      '<Row visitText="now" />',
      '<span class={["meta", "otk-time-unit"]} />',
    ]
  ) assert(conventionErrors("time-text", path, text).length, text);
  assert(
    conventionErrors(
      "time-text",
      "packages/ui/Fixture.css",
      ".otk-time { color: inherit; }",
    ).length,
  );
  for (
    const text of [
      "<span title={elapsed(x).text} />",
      "<TimeText time={elapsed(x)} />",
      "<TimeText time={row.visit} />",
      "<span>{note.text}</span>",
    ]
  ) assertEquals(conventionErrors("time-text", path, text), [], text);
});

function staticText(source: Source, node: t.Node): string | undefined {
  const value = source.value(node);
  if (value?.type === "BinaryExpression" && value.operator === "+") {
    const left = staticText(source, value.left),
      right = staticText(source, value.right);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return source.string(value);
}

Deno.test("UI convention: failure wording rejects diagnostics outside Details", () => {
  for (
    const text of [
      'const facts = {reason: "localStorage is full"};',
      "const facts = {recovery: `Free 5 MB (${bytes} bytes)`};",
      'fail(target, "Could not save 123 bytes", "Retry", "Saving");',
    ]
  ) {
    assert(
      conventionErrors("failure-wording", "Fixture.ts", text).length > 0,
      text,
    );
  }
  assertEquals(
    conventionErrors(
      "failure-wording",
      "Fixture.ts",
      'const facts = {reason: "Storage is full", recovery: "Retry", details: "localStorage: 123 bytes, 5 MB quota"};',
    ),
    [],
  );
});

Deno.test("UI convention: list ordering rejects activity/state keys and accepts saved moves and creation", () => {
  for (
    const text of [
      "tasks.sort((a,b) => b.timeUpdated-a.timeUpdated);",
      "const byRecency = (a,b) => b.lastActivity-a.lastActivity; projects.sort(byRecency);",
      "owner.order(rows, row => ({position: rank[row.status]}));",
      "const row = {order: -summary.lastActivity};",
      "checkouts.toSorted((a,b) => urgentStatus(a)-urgentStatus(b));",
      "tasks.sort((a,b) => a.state-b.state);",
    ]
  ) {
    assert(
      conventionErrors("list-order", "packages/client/inbox.ts", text).length >
        0,
      text,
    );
  }
  for (
    const text of [
      "tasks.sort((a,b) => a.order-b.order);",
      "entries.sort((a,b) => a.timeCreated-b.timeCreated);",
      "owner.order(rows, row => ({position:row.order,created:row.timeCreated}));",
      "const lamps = rollupStatus(working,finished);",
    ]
  ) {
    assertEquals(
      conventionErrors("list-order", "packages/client/inbox.ts", text),
      [],
      text,
    );
  }
});

Deno.test("UI convention: message footer rejects concealed metadata and independent action owners", () => {
  assert(
    conventionErrors(
      "message-footer",
      "packages/ui/components/ExtractedHeader.tsx",
      'import Instant from "./Clock.tsx"; export const Header=()=> <header data-message-header><Instant at={1}/></header>;',
    ).length > 0,
    "an extracted message header escapes the clock owner",
  );
  for (const path of ["Message.tsx", "Timeline.tsx", "MovedHeader.tsx"]) {
    assert(
      conventionErrors(
        "message-footer",
        `packages/ui/components/${path}`,
        'import Instant from "./Clock.tsx"; const view=<header data-message-header><Instant at={1} /></header>;',
      ).length > 0,
    );
  }
  assertEquals(
    conventionErrors(
      "message-footer",
      "packages/ui/components/MessageFooter.tsx",
      'import Instant from "./Clock.tsx"; const view=<Instant at={1} />;',
    ),
    [],
  );
  for (
    const text of [
      ".otk-message-actions {opacity: 0}",
      ".otk-created-time {visibility: hidden}",
      ".otk-user-meta {display:none}",
      ".otk-timeline-clock {visibility:hidden}",
    ]
  ) {
    assert(conventionErrors("message-footer", "Fixture.css", text).length > 0);
  }
  assert(
    conventionErrors(
      "message-footer",
      "packages/ui/components/Message.tsx",
      'import Actions from "./MessageActions.tsx"; const view=<Actions />;',
    ).length > 0,
  );
  assert(
    conventionErrors(
      "message-footer",
      "Fixture.tsx",
      '<button data-message-command="prompt.copy"><CopyIcon /></button>',
    ).length > 0,
  );
  assertEquals(
    conventionErrors(
      "message-footer",
      "Fixture.css",
      ".otk-message-actions {color: var(--otk-fg-3)} .otk-message-actions:hover {color: inherit}",
    ),
    [],
  );
  assertEquals(
    conventionErrors(
      "message-footer",
      "packages/ui/components/MessageFooter.tsx",
      'import Actions from "./MessageActions.tsx"; const view=<Actions />;',
    ),
    [],
  );
});

Deno.test("UI convention: container chrome work-log intent belongs to the reply", async () => {
  const files = (source: string) => new Map([["Fixture.tsx", source]]);
  assertEquals(
    containerChromeErrors(files('interaction.workDisclosure("reply", ["a"])')),
    ["Fixture.tsx:1: workDisclosure must not take members"],
  );
  assertEquals(
    containerChromeErrors(
      files('retainedWorkDisclosure("reply", members, prefs, required)'),
    ),
    ["Fixture.tsx:1: retainedWorkDisclosure must not take members"],
  );
  assertEquals(
    containerChromeErrors(files('interaction.workDisclosure("reply")')),
    [],
  );
  assertEquals(
    containerChromeErrors(
      files('retainedWorkDisclosure("reply", prefs, required)'),
    ),
    [],
  );
  assertEquals(containerChromeErrors(await productionSources()), []);
});

Deno.test("UI convention: header clock ownership follows component roles and extracted renderers", async () => {
  assertEquals(messageHeaderClockErrors(await productionSources()), []);
  const wrapper = new Map([
    [
      "views/Frame.tsx",
      'import Band from "./Renamed.tsx"; const view=<header data-message-header><Band /></header>;',
    ],
    [
      "views/Renamed.tsx",
      'import Instant from "../Clock.tsx"; export default function Band(){return <span><Instant at={1}/></span>}',
    ],
  ]);
  assert(messageHeaderClockErrors(wrapper).length > 0);
  wrapper.set(
    "views/Renamed.tsx",
    'import Preview from "../Popover.tsx"; import Instant from "../Clock.tsx"; export default function Band(){return <Preview><Instant at={1}/></Preview>}',
  );
  assertEquals(messageHeaderClockErrors(wrapper), []);
  assertEquals(
    messageHeaderClockErrors(
      new Map([[
        "records/History.tsx",
        'import Instant from "../Clock.tsx"; const view=<header class="record-heading"><Instant at={1}/></header>;',
      ]]),
    ),
    [],
  );
});

/** Positive data flow into fixture consumers, not a token-presence obligation. */
export function fixtureFeedbackErrors(text: string): string[] {
  const source = new Source(text);
  const owned = (input: t.Node, seen = new Set<t.Node>()): boolean => {
    const value = source.value(input);
    if (!value || seen.has(value)) return false;
    seen.add(value);
    if (value.type === "CallExpression") {
      const imported = source.imported(value.callee);
      return imported?.module === "@otk/client" &&
        ["presentFailure", "errorFeedback", "attachmentFailure", "failureValue"]
          .includes(imported.name);
    }
    if (value.type === "ObjectExpression") {
      const spreads = value.properties.filter((p): p is t.SpreadElement =>
        p.type === "SpreadElement"
      );
      return spreads.length > 0 && spreads.every((p) =>
        owned(p.argument, new Set(seen))
      ) &&
        !value.properties.some((p) =>
          p.type === "ObjectProperty" &&
          ["failure", "kind", "text"].includes(property(p.key) ?? "")
        );
    }
    return false;
  };
  return source.all.flatMap((node) => {
    const value =
      node.type === "JSXAttribute" && property(node.name) === "feedback"
        ? node.value
        : node.type === "ObjectProperty" && property(node.key) === "feedback"
        ? node.value
        : undefined;
    return value && source.live(node) && !owned(value)
      ? [
        `line ${node.loc?.start.line}: rendered feedback must derive from the production presenter`,
      ]
      : [];
  });
}

Deno.test("UI convention: style fixture feedback flows from production presenters into actual consumers", async () => {
  for (const path of ["error-surfaces", "ui-conventions", "failure-layout"]) {
    const text = await Deno.readTextFile(
      new URL(
        `../../packages/ui/tests/style-consumer/${path}.tsx`,
        import.meta.url,
      ),
    );
    assertEquals(fixtureFeedbackErrors(text), [], path);
  }
  const imported = 'import { presentFailure as present } from "@otk/client";';
  assertEquals(
    fixtureFeedbackErrors(
      `${imported} const shown = present(facts); const view = <FeedbackStatus feedback={{...shown, action}} />;`,
    ),
    [],
  );
  for (
    const body of [
      "/* presentFailure(facts) */ const view = <FeedbackStatus feedback={madeUp} />;",
      "if (false) present(facts); const view = <FeedbackStatus feedback={madeUp} />;",
      "const shown = present(facts); const view = <FeedbackStatus feedback={{...shown, failure: madeUp}} />;",
      "const shown = present(facts); const view = <FeedbackStatus feedback={unrelated} />;",
      "const view = <FeedbackStatus feedback={presentFailure(facts)} />;",
    ]
  ) assert(fixtureFeedbackErrors(imported + body).length > 0, body);
});

for (const rule of Object.keys(owners) as Rule[]) {
  Deno.test(`UI convention: ${owners[rule]}`, async () => {
    const failures: string[] = [];
    for (const [path, text] of await productionSources()) {
      if (
        (rule === "duration" || rule === "time-text")
          ? /^(?:packages|core)\//.test(path)
          : /^(?:packages\/(?:client|ui)\/|web\/src\/)/.test(path)
      ) {
        failures.push(...conventionErrors(rule, path, text));
      }
    }
    if (rule === "presentation") {
      for (const [path, text] of await sourceInventory({ tests: true })) {
        if (path.startsWith("packages/ui/tests/") && path.endsWith(".tsx")) {
          failures.push(...conventionErrors(rule, path, text));
        }
      }
    }
    assertEquals(failures, [], failures.join("\n"));
    if (rule === "meta-tone") {
      const meta = rules(
        await Deno.readTextFile(
          new URL(
            "../../packages/ui/components/ChromeMeta.css",
            import.meta.url,
          ),
        ),
      )
        .find((rule) => rule.selector === ".otk-chrome-meta")!;
      assertEquals(
        meta.declarations.get("font-weight"),
        "400",
        "ChromeMeta owns the same weight inside and outside controls",
      );
      assertEquals(
        meta.declarations.get("color"),
        "var(--otk-fg-3)",
        owners["meta-tone"],
      );
    }
  });
}

Deno.test("UI convention: failure presenter drops current-session targets on every inline surface, notifications retain them", () => {
  const target = {
    sidecarId: "local",
    sessionID: "current",
    label: "Open session",
  };
  const presenter = new FailurePresenter({
    target: () => ({ label: target.label, href: "/current" }),
  });
  const value = {
    code: "test.failure",
    retry: "none" as const,
    diagnosticID: "test",
    facts: { actionLabel: "Sending prompt", target, reason: "Refused" },
  };
  for (
    const surface of ["record", "feedback", "session", "notification"] as const
  ) {
    const shown = presenter.describe(value, { surface, view: target }).failure!;
    assertEquals(
      shown.target,
      surface === "notification"
        ? { label: target.label, href: "/current" }
        : { label: "" },
      `FailurePresenter must drop self-links for ${surface}`,
    );
  }
});

Deno.test("UI convention: unknown outcomes have neutral tone derived by FailurePresenter, never the failure stripe", () => {
  for (const outcome of ["unknown", "unavailable"] as const) {
    const shown = new FailurePresenter().describe({
      code: "test.pending",
      retry: "none",
      diagnosticID: "pending",
      facts: { outcome, actionLabel: "Sending prompt" },
    });
    assertEquals(shown.kind, "pending");
    assertEquals(
      shown.failure?.tone,
      "neutral",
      "FailurePresenter owns tone from outcome, not the caller",
    );
  }
});

export function attachmentFixtureErrors(path: string, text: string): string[] {
  const source = new Source(text, path);
  const errors = source.all.filter((node): node is t.ObjectProperty => {
    if (
      node.type !== "ObjectProperty" || property(node.key) !== "error" ||
      !source.live(node)
    ) return false;
    const parent = source.parent.get(node);
    return parent?.type === "ObjectExpression" &&
      parent.properties.some((p) =>
        p.type === "ObjectProperty" &&
        ["pending", "part"].includes(property(p.key) ?? "")
      );
  });
  const valid = errors.filter((node) => {
    const call = source.value(node.value);
    if (call?.type !== "CallExpression") return false;
    const imported = source.imported(call.callee);
    if (
      imported?.module !== "@otk/client" ||
      imported.name !== "attachmentFailure"
    ) return false;
    if (path.includes("features/prompt/")) {
      const object = source.parent.get(node),
        patch = object && source.parent.get(object);
      return patch?.type === "CallExpression" &&
        source.name(patch.callee) === "patch" &&
        source.name(call.arguments[0]) === "error" &&
        source.name(call.arguments[1]) === "file.name";
    }
    const parent = source.parent.get(node);
    const label = parent?.type === "ObjectExpression"
      ? parent.properties.find((p) =>
        p.type === "ObjectProperty" && property(p.key) === "label"
      )
      : undefined;
    let consumer: t.Node | undefined = node;
    while (consumer && consumer.type !== "JSXAttribute") {
      consumer = source.parent.get(consumer);
    }
    const opening = consumer && source.parent.get(consumer);
    return consumer?.type === "JSXAttribute" &&
      property(consumer.name) === "chips" &&
      opening?.type === "JSXOpeningElement" &&
      source.imported(opening.name)?.module.endsWith("/prompt/Chips.tsx") ===
        true &&
      label?.type === "ObjectProperty" &&
      source.string(label.value) !== undefined &&
      source.string(label.value) === source.string(call.arguments[1]);
  });
  return valid.length === 1 && errors.length === 1 ? [] : [
    `${path}: actual chip error must consume attachmentFailure(cause, original filename)`,
  ];
}

Deno.test("UI convention: attachment fixtures and the app use the same file-target failure builder", async () => {
  for (
    const path of [
      "packages/ui/features/prompt/attachments.tsx",
      "packages/ui/tests/style-consumer/error-surfaces.tsx",
    ]
  ) {
    const text = await Deno.readTextFile(
      new URL(`../../${path}`, import.meta.url),
    );
    assertEquals(attachmentFixtureErrors(path, text), []);
    for (
      const changed of [
        text.replace("error: attachmentFailure(", "error: unrelated("),
        text.replace("import { attachmentFailure }", "import { unrelated }"),
        text.replace("error, file.name", 'error, "wrong.txt"').replace(
          '"unreadable-attachment.txt",\n                )',
          '"wrong.txt",\n                )',
        ),
      ]
    ) {
      if (changed !== text) {
        assert(attachmentFixtureErrors(path, changed).length > 0);
      }
    }
  }
});

Deno.test("UI convention gates distinguish artwork, numeric locales and intrinsic layout from violations", () => {
  const bad: [Rule, string, string][] = [
    ["clock", "Fixture.tsx", "new Date(at).toLocaleString()"],
    ["clock", "Fixture.tsx", "instant.toLocaleTimeString()"],
    [
      "icons",
      "Fixture.tsx",
      'interface Tool { icon: string | (() => Element) }; const row = { icon: "?" };',
    ],
    ["icons", "Fixture.tsx", '<span aria-hidden="true">✓</span>'],
    ["ellipsis", "Fixture.tsx", 'const text = "Loading\\u2026";'],
    [
      "meta-tone",
      "Fixture.css",
      ".otk-record-group-failures { color: var(--danger) }",
    ],
    ["masks", "Fixture.css", ".otk-tree-toggle rect { fill: var(--otk-bg) }"],
    ["native", "Fixture.tsx", "<details><summary>Details</summary></details>"],
    ["native", "Fixture.tsx", "<select />"],
    [
      "native",
      "Fixture.tsx",
      'function Preview(props: {preview?: boolean}) { return <button popovertarget="p" title="Native tooltip" />; }',
    ],
    [
      "alignment",
      "Fixture.css",
      ".otk-connection-status.has-failure { --failure-gutter: calc(var(--control-size) + var(--space-2)) }",
    ],
    ["alignment", "Fixture.css", ".otk-send-failure { inline-size: 80% }"],
    [
      "disclosure",
      "Fixture.css",
      ".otk-disclosure-toggle { grid-template-columns: 19px auto }",
    ],
    ["meta-list", "Fixture.tsx", "<ChromeMeta>·</ChromeMeta>"],
  ];
  for (const [rule, path, text] of bad) {
    assert(conventionErrors(rule, path, text).length > 0, `${rule}: ${text}`);
  }
  assertEquals(
    conventionErrors("clock", "Fixture.tsx", "bytes.toLocaleString()"),
    [],
  );
  assertEquals(
    conventionErrors(
      "icons",
      "Fixture.tsx",
      'import { SearchIcon } from "@otk/ui"; const tool = { icon: SearchIcon }; const icon = <svg><path d="M1 1h8" /></svg>;',
    ),
    [],
  );
  assertEquals(
    conventionErrors(
      "icons",
      "Fixture.tsx",
      "function Avatar(props: { image?: string }) { return <img src={props.image} />; }",
    ),
    [],
  );
  assertEquals(
    conventionErrors(
      "icons",
      "Fixture.tsx",
      "function Avatar(props: { icon?: string }) { return <img src={props.icon} />; }",
    ),
    [],
  );
  assertEquals(
    conventionErrors(
      "alignment",
      "Fixture.css",
      ".otk-connection-status.has-failure { grid-template-columns: subgrid } .otk-send-failure { inline-size: fit-content; max-inline-size: 100% }",
    ),
    [],
  );
  assertEquals(
    conventionErrors(
      "alignment",
      "Fixture.css",
      ".otk-user-message { --user-column: 80% }",
    ),
    [],
  );
});
