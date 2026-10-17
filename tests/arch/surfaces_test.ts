// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { THEME_SLOTS } from "../../packages/ui/theme/slots.ts";

type Sources = Map<string, string>;
const root = new URL("../../packages/ui/", import.meta.url);
async function sources(directory = root, prefix = ""): Promise<Sources> {
  const files: Sources = new Map();
  for await (const entry of Deno.readDir(directory)) {
    const name = prefix + entry.name;
    if (entry.isDirectory) {
      if (entry.name === "tests") continue;
      for (
        const item of await sources(
          new URL(`${entry.name}/`, directory),
          `${name}/`,
        )
      ) files.set(...item);
    } else if (/\.(tsx?|css)$/.test(name)) {
      files.set(name, await Deno.readTextFile(new URL(entry.name, directory)));
    }
  }
  return files;
}
function ownershipErrors(files: Sources): string[] {
  const errors: string[] = [];
  const owners = /^components\/surface\/(Dialog|Popover|Menu|Toast)\.tsx$/;
  const overlay = new Set<string>();
  for (const [name, text] of files) {
    if (
      /\b(?:import|export)\b[^;]*["'][^"']*\/Surface(?:\.tsx)?["']/.test(
        text,
      ) && !owners.test(name)
    ) errors.push(`${name}: Surface is internal`);
    if (/<dialog\b/.test(text) && name !== "components/surface/Dialog.tsx") {
      errors.push(`${name}: native dialog belongs to Dialog`);
    }
    if (
      name === "components/surface/Popover.tsx" && /togglePopover\(/.test(text)
    ) {
      errors.push(
        `${name}: native popovertarget association owns trigger toggling`,
      );
    }
    if (
      name === "components/surface/Dialog.css" &&
      /\[data-dialog[=\]]/.test(text)
    ) {
      errors.push(
        `${name}: Dialog sizes content without caller-specific rules`,
      );
    }
    if (
      /\bpopover=["']/.test(text) && name !== "components/surface/Popover.tsx"
    ) errors.push(`${name}: native popover belongs to Popover`);
    if (
      /dialogs\.register|<(?:Popover|Menu|Toast)\b/.test(text) &&
      !owners.test(name)
    ) overlay.add(name);
  }
  // Follow component dependencies of registrations and anchored content. This
  // catches new content modules, not just today's concrete overlay names.
  for (const name of overlay) {
    const text = files.get(name)!;
    const content = /<(?:Popover|Menu|Toast)\b/.test(text)
      ? [
        ...text.matchAll(
          /<(?:Popover|Menu|Toast)\b[\s\S]*?<\/(?:Popover|Menu|Toast)>/g,
        ),
      ].map((m) => m[0]).join("\n")
      : text;
    for (
      const match of text.matchAll(
        /import\s+(\w+)\s+from\s+["']([^"']+\.tsx)["']/g,
      )
    ) {
      if (!new RegExp(`(?:<|component:\\s*)${match[1]}\\b`).test(content)) {
        continue;
      }
      const url = new URL(match[2], new URL(name, root));
      const child = url.href.slice(root.href.length);
      if (
        files.has(child) && !child.includes("/surface/") &&
        !child.startsWith("registries/") && !child.startsWith("shell/") &&
        !child.startsWith("keyboard/")
      ) overlay.add(child);
    }
  }
  const allowedPositions = new Set([
    "components/surface/Popover.css:.otk-popover-panel", // The anchored overlay itself, never content.
    "components/ProjectInbox.css:.otk-project-menu", // Existing parked trigger placement.
    "components/ProjectInbox.css:.otk-inbox-resizer",
    "components/Toasts.css:.otk-toasts", // Existing fixed notification stack.
  ]);
  for (const [name, text] of files) {
    if (!name.endsWith(".css")) continue;
    for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim(),
        body = match[2];
      // Overlay-surfaces plan §2 explicitly parks the shared selection-marker
      // structure. Its existing theme.css pseudo-element is not overlay layout.
      const parkedSelectionMarker = name === "theme.css" &&
        selector.includes("[data-otk-selection");
      const surface = name === "components/surface/Surface.css";
      const shadow = /box-shadow\s*:\s*([^;]+)/.exec(body)?.[1].trim();
      if (
        !surface && /background(?:-color)?\s*:/.test(body) &&
        /border-radius\s*:/.test(body) && shadow && shadow !== "none" &&
        name !== "components/ComposerTakeovers.css" && name !== "theme.css"
      ) errors.push(`${name}: card paint belongs to Surface`);
      if (
        /\b(?:fieldset|legend)\b/.test(selector) &&
        /(?:background|border-radius|box-shadow)\s*:/.test(body)
      ) errors.push(`${name}: field grouping is not a surface`);
      if (
        !parkedSelectionMarker &&
        (overlay.has(name.replace(/\.css$/, ".tsx")) ||
          /^components\/surface\/\w+\.css$/.test(name)) &&
        !allowedPositions.has(`${name}:${selector}`)
      ) {
        if (
          /position\s*:\s*(?:absolute|fixed)|(?:^|;)\s*(?:top|left|right|bottom|inset)\s*:|margin(?:-[\w-]+)?\s*:[^;]*-\d/
            .test(body)
        ) errors.push(`${name}: overlay content must stay in flow`);
      }
    }
  }
  return errors;
}
function tokenErrors(files: Sources): string[] {
  const defined = new Set(THEME_SLOTS.map((slot) => `--otk-${slot}`));
  for (const text of files.values()) {
    for (const match of text.matchAll(/(--[\w-]+)["']?\s*:/g)) {
      defined.add(match[1]);
    }
  }
  return [...files].filter(([name]) => name.endsWith(".css")).flatMap((
    [name, css],
  ) =>
    [...css.matchAll(/var\(\s*(--[\w-]+)/g)].filter((match) =>
      !defined.has(match[1])
    ).map((match) => `${name}: undefined ${match[1]}`)
  );
}
Deno.test("overlay owners enforce an internal Surface and normal-flow registered content", async () => {
  assertEquals(ownershipErrors(await sources()), []);
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
      ["components/surface/Dialog.css", ".otk-surface-body { top: 8px; }"],
      [
        "components/surface/Dialog.css",
        ".otk-dialog[data-dialog=feature] { width: 90vw; }",
      ],
    ]
  ) assert(ownershipErrors(new Map([[name, text]])).length, text);
  for (
    const declaration of [
      "position: absolute",
      "position: fixed",
      "top: 8px",
      "margin-top: -8px",
    ]
  ) {
    assert(
      ownershipErrors(
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
