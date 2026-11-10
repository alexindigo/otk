// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mentionOptions } from "../components/prompt/autocomplete.ts";

Deno.test("agent mentions display labels but submit native identities", () => {
  const rows = mentionOptions({
    agents: [{ id: "general", name: "General helper" }],
    files: [],
    resources: [],
    frecency: [],
    directory: "/project",
  }, "General");
  assertEquals(rows.length, 1);
  assertEquals(rows[0].label, "General helper");
  assertEquals(rows[0].id, "agent:general");
  assertEquals(rows[0].part, { kind: "agent", name: "general" });
});
