// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertStringIncludes } from "@std/assert";

Deno.test("task identity is owned by the shared group partition, not activity or selection", async () => {
  const tabs = await Deno.readTextFile("packages/client/tabs.ts");
  assertStringIncludes(tabs, "projectTabGroups(");
  const partition = await Deno.readTextFile("packages/protocol/tab-groups.ts");
  const client = await Deno.readTextFile("packages/client/tab-groups.ts");
  assertStringIncludes(client, 'from "@otk/protocol"');
  assert(!partition.includes("options.mandatory?.has(id)"));
  assert(!partition.includes("options.retained?.has(id)"));
  assertStringIncludes(partition, "rootID");
  const crumbs = await Deno.readTextFile("packages/client/task-breadcrumbs.ts");
  assertStringIncludes(crumbs, "projectTabGroups(");
  const actions = await Deno.readTextFile("packages/client/session-actions.ts");
  assertStringIncludes(actions, "tabs.taskFor(id)");
  assert(!actions.includes("familyTask("));
});
