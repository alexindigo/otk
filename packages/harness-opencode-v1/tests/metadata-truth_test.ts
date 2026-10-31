// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { mapDiffs } from "../map.ts";
import { mapTodos, mapTool } from "../map-tools.ts";
import { mapModels, type Providers } from "../models.ts";
import type { RawPart } from "../types.ts";

const search = (metadata: Record<string, unknown> = {}, output?: string) =>
  mapTool(
    {
      id: "p",
      sessionID: "s",
      messageID: "m",
      type: "tool",
      tool: "grep",
      callID: "c",
      state: { status: "completed", input: {}, metadata, output },
    } satisfies RawPart,
  );

Deno.test("native search counts distinguish unknown, reported zero and complete decoded results", () => {
  const missing = search();
  if (missing.tool !== "search") throw new Error("Expected search");
  assertEquals(missing.pattern, undefined);
  assertEquals(missing.matches, undefined);
  const zero = search({ matches: 0 });
  if (zero.tool !== "search") throw new Error("Expected search");
  assertEquals(zero.matches, 0);
  const complete = search(
    {},
    "Found 1 matches\n/project/file.ts:\n  Line 1: result\n",
  );
  if (complete.tool !== "search") throw new Error("Expected search");
  assertEquals(complete.matches, 1);
  const truncated = search(
    {},
    "Found 1 matches (more matches available)\n/project/file.ts:\n  Line 1: result\n",
  );
  if (truncated.tool !== "search") throw new Error("Expected search");
  assertEquals(truncated.matches, undefined);
});

Deno.test("native missing diff path, status and todo priority remain unreported", () => {
  assertEquals(mapDiffs([{ additions: 0, deletions: 0 }])[0], {
    path: undefined,
    status: "unknown",
    additions: 0,
    deletions: 0,
    hunks: [],
  });
  assertEquals(
    mapDiffs([{
      file: "unknown",
      status: "modified",
      additions: 1,
      deletions: 0,
    }])[0].path,
    "unknown",
  );
  assertEquals(mapTodos([{ content: "Task", status: "pending" }]), [
    { content: "Task", status: "pending", priority: undefined },
  ]);
});

Deno.test("free classification uses all reported rates independently of provider identity", () => {
  const costs: Providers["providers"][number]["models"][string]["cost"][] = [
    undefined,
    { input: 0 },
    { input: 0, output: 1 },
    { input: 0, output: 0, cache: { read: 0, write: 0 } },
    { input: 0, output: 0, cache: { read: 0, write: 2 } },
  ];
  for (const id of ["opencode", "independent"]) {
    const catalog = mapModels({
      providers: [{
        id,
        name: id,
        models: Object.fromEntries(costs.map((cost, i) => [String(i), {
          id: String(i),
          name: String(i),
          status: "active" as const,
          cost,
        }])),
      }],
    }, {});
    assertEquals(catalog.providers[0].models.map((model) => model.free), [
      null,
      null,
      false,
      true,
      false,
    ]);
    assertEquals(catalog.defaultState, "unknown");
    assertEquals(catalog.default, undefined);
  }
});
