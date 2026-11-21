// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ExternalCall } from "@otk/protocol";
import { ToolRegistry } from "../registries/renderers.ts";
Deno.test("unknown tool presentation has one name and only distinct detail", () => {
  const registry = new ToolRegistry();
  const call: ExternalCall = {
    tool: "external",
    callID: "call",
    name: "custom",
    summary: "",
    status: "completed",
    time: {},
  };
  for (const summary of ["", "custom"]) {
    const { icon, ...presentation } = registry.presentation({
      ...call,
      summary,
    });
    assertEquals(icon(), null);
    assertEquals(presentation, {
      verb: "custom",
      summary: undefined,
    });
  }
  assertEquals(
    registry.presentation({ ...call, summary: "A distinct title" }).summary,
    "A distinct title",
  );
});
