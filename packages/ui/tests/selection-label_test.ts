// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { selectionLabel } from "../components/prompt/selection-label.ts";

Deno.test("selection labels title-case names and preserve literal fallback phrases", () => {
  assertEquals(selectionLabel(undefined, "Default agent"), "Default agent");
  assertEquals(selectionLabel(undefined, "Default model"), "Default model");
  assertEquals(selectionLabel(undefined, "Default"), "Default");
  assertEquals(selectionLabel("build", "Default agent"), "Build");
  assertEquals(selectionLabel("high", "Default"), "High");
  assertEquals(selectionLabel("custom-agent_name"), "Custom-Agent_Name");
  assertEquals(selectionLabel("default agent", "unused"), "Default Agent");
  assertEquals(selectionLabel("", "Default agent"), "");
});
