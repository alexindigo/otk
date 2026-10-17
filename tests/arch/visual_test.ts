// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

function visualErrors(css: string, base = false, lights = false): string[] {
  const errors: string[] = [];
  if (
    !lights && /\banimation(?:-iteration-count)?:[^;{}]*\binfinite\b/.test(css)
  ) {
    errors.push("continuous motion belongs to status lights");
  }
  if (!base && /(?:font-family|font)\s*:[^;{}]*["']IBM Plex/.test(css)) {
    errors.push("font bypasses tokens");
  }
  if (/font-size\s*:\s*(\d*\.?\d+)(px|rem)/g.test(css)) {
    for (const match of css.matchAll(/font-size\s*:\s*(\d*\.?\d+)(px|rem)/g)) {
      if (Number(match[1]) * (match[2] === "rem" ? 13 : 1) < 12) {
        errors.push("text below 12px");
      }
    }
  }
  for (
    const match of css.matchAll(
      /(?:padding|margin|gap)(?:-[\w-]+)?\s*:\s*([^;{}]+)/g,
    )
  ) {
    if (/rem\b/.test(match[1])) errors.push("spacing bypasses 4px grid");
    for (const value of match[1].matchAll(/([\d.]+)px/g)) {
      if (Number(value[1]) % 4 !== 0) errors.push("spacing bypasses 4px grid");
    }
  }
  return errors;
}
Deno.test("visual typography and spacing stay behind the shared contract", async () => {
  async function inspect(directory: URL): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const file = new URL(
        entry.name + (entry.isDirectory ? "/" : ""),
        directory,
      );
      if (entry.isDirectory) await inspect(file);
      else if (entry.name.endsWith(".css")) {
        const css = await Deno.readTextFile(file);
        assertEquals(
          visualErrors(
            css,
            entry.name === "theme.css",
            entry.name === "StatusLight.css",
          ),
          [],
          file.pathname,
        );
      }
    }
  }
  await inspect(new URL("../../packages/ui/", import.meta.url));
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

function selectionErrors(source: string): string[] {
  return [...source.matchAll(/<(?:button|a)\b[^>]*(?:\{[^}]*\}[^>]*)*>/g)]
    .filter(([tag]) =>
      /\b(?:aria-selected|aria-current|aria-pressed|data-selected)=|\.\.\.selection\(/
        .test(tag) && !/data-otk-selection="(?:vertical|horizontal)"/.test(tag)
    )
    .map(() => "selected chrome item bypasses the shared selection primitive");
}
Deno.test("chrome selected/current states opt into the shared orientation primitive", async () => {
  for (
    const name of [
      "ProjectInbox",
      "ProjectTabs",
      "ProjectSessions",
      "RightPanel",
      "ThemePicker",
      "Palette",
      "Sidebar",
      "QuestionDock",
    ]
  ) {
    assertEquals(
      selectionErrors(
        await Deno.readTextFile(
          new URL(`../../packages/ui/components/${name}.tsx`, import.meta.url),
        ),
      ),
      [],
      name,
    );
  }
  assertEquals(
    selectionErrors('<button aria-current={selected ? "page" : undefined}>'),
    ["selected chrome item bypasses the shared selection primitive"],
  );
  assertEquals(
    selectionErrors(
      '<button data-otk-selection="vertical" {...selection({ kind: "current", selected })}>',
    ),
    [],
  );
});

function resizeErrors(source: string): string[] {
  return /parentElement[\s\S]*?getBoundingClientRect/.test(source) ||
      !source.includes("resizeDrag(")
    ? [
      "resizing must use an immutable pointer-delta gesture, not a parent edge",
    ]
    : [];
}
Deno.test("both column resizers share border-independent pointer-delta ownership", async () => {
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
    resizeErrors("drag = resizeDrag(width(), event.clientX, -1, 280, 480);"),
    [],
  );
});
