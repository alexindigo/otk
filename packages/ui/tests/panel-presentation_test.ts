// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { panelMode } from "../state/panel-presentation.ts";

Deno.test("panel presentation reserves room for the conversation", () => {
  const narrow = {
    app: 720,
    left: 248,
    leftCollapsed: false,
    rail: 48,
    right: 320,
    mainMin: 420,
    open: true,
  };
  assertEquals(panelMode(narrow), "sheet");
  assertEquals(panelMode({ ...narrow, leftCollapsed: true }), "sheet");
  assertEquals(panelMode({ ...narrow, app: 1024 }), "inline");
  assertEquals(panelMode({ ...narrow, app: 988 }), "inline");
  assertEquals(panelMode({ ...narrow, app: 800 }), "sheet");
  assertEquals(
    panelMode({ ...narrow, app: 800, leftCollapsed: true }),
    "inline",
  );
  assertEquals(panelMode({ ...narrow, open: false }), "inline");
});
