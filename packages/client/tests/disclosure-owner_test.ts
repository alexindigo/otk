// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  DEFAULT_PREFS,
  preferences,
  preferenceToggleValue,
} from "@otk/protocol";
import { createTranscriptInteraction } from "../transcript-interaction.ts";
import { toolFailure } from "../tool-failure.ts";

Deno.test("disclosure defaults cover every neutral category and preserve saved meanings", () => {
  const owner = createTranscriptInteraction();
  for (
    const category of [
      "work",
      "toolOutput",
      "reasoning",
      "fileChanges",
      "system",
      "delegation",
      "outgoing",
      "compaction",
      "record",
      "source",
    ] as const
  ) assertEquals(owner.defaultFor(category), false, category);
  assertEquals(owner.defaultFor("reasoning", { thinking: "show" }), true);
  assertEquals(owner.defaultFor("reasoning", { thinking: "hide" }), false);
  assertEquals(
    owner.defaultFor("fileChanges", { collapseFileChanges: false }),
    true,
  );
  assertEquals(
    owner.defaultFor("fileChanges", { collapseFileChanges: true }),
    false,
  );
  assertEquals(DEFAULT_PREFS.genericToolOutput, true);
  for (const value of [false, true]) {
    assertEquals(preferences.validate("genericToolOutput", value), true);
    assertEquals(preferences.validate("toolDetails", value), true);
    assertEquals(
      { ...DEFAULT_PREFS, genericToolOutput: value }.genericToolOutput,
      value,
    );
  }
  assertEquals(
    preferences.settings("transcript").filter((row) =>
      row.key.startsWith("expand")
    ).length,
    8,
  );
  for (
    const row of preferences.settings("transcript").filter((row) =>
      row.key.startsWith("expand")
    )
  ) {
    assertEquals(row.default, false, row.key);
    assertEquals(row.settings!.control.kind, "toggle", row.key);
    assertEquals(preferences.validate(row.key, true), true, row.key);
    assertEquals(preferences.validate(row.key, "true"), false, row.key);
  }
});

Deno.test("explicit true and false win; defaults remain live only for unset choices", () => {
  const owner = createTranscriptInteraction();
  const open = owner.disclosure("open", "one");
  const closed = owner.disclosure("closed", "one");
  const unset = owner.disclosure("unset", "one");
  open.set(true);
  closed.set(false);
  for (const expandWork of [false, true, false]) {
    const prefs = { expandWork };
    assertEquals(open.expanded("work", prefs), true);
    assertEquals(closed.expanded("work", prefs), false);
    assertEquals(unset.expanded("work", prefs), expandWork);
    assertEquals(unset.value(), undefined);
  }
});

Deno.test("Settings has one positive toggle per disclosure kind and separates visibility", () => {
  const owner = createTranscriptInteraction();
  const rows = preferences.settings("transcript");
  const categories = [
    ["work", "expandWork"],
    ["toolOutput", "expandToolOutput"],
    ["fileChanges", "collapseFileChanges"],
    ["reasoning", "thinking"],
    ["system", "expandSystem"],
    ["delegation", "expandDelegation"],
    ["outgoing", "expandOutgoing"],
    ["record", "expandRecords"],
    ["source", "expandSource"],
    ["compaction", "expandCompaction"],
  ] as const;
  assertEquals(rows.map((row) => row.key), categories.map((row) => row[1]));
  for (const [category, key] of categories) {
    const row = rows.find((row) => row.key === key)!;
    assertEquals(row.settings!.control.kind, "toggle");
    assertEquals(
      row.label === "Always keep session compaction expanded" ||
        /^Expand .+ by default$/.test(row.label),
      true,
    );
    for (const checked of [false, true]) {
      assertEquals(
        owner.defaultFor(category, {
          ...DEFAULT_PREFS,
          [key]: preferenceToggleValue(row.settings!.control, checked),
        }),
        checked,
        key,
      );
    }
  }
  assertEquals(
    preferences.settings("transcript-visibility").map((
      row,
    ) => [row.key, row.label]),
    [["toolDetails", "Show successful tool rows"], [
      "genericToolOutput",
      "Show results for unrecognized tools",
    ]],
  );
});

Deno.test("nested choices survive parent closing, virtual remount and preference changes", () => {
  const owner = createTranscriptInteraction();
  const parent = owner.disclosure("reply:1/work", "one");
  const child = owner.disclosure("reply:1/part:2/tool", "two");
  child.set(true);
  parent.set(false);
  parent.set(true);
  const remount = owner.disclosure("reply:1/part:2/tool", "two");
  assertEquals(
    remount.expanded("toolOutput", { expandToolOutput: false }),
    true,
  );
  remount.set(false);
  assertEquals(child.expanded("toolOutput", { expandToolOutput: true }), false);
});

Deno.test("retired generations cannot transfer choices or mutate replacements", () => {
  const owner = createTranscriptInteraction();
  const first = owner.disclosure("part:1", owner.generation("one"));
  first.set(true);
  owner.retireIdentity("one");
  const replacement = owner.disclosure("part:1", owner.generation("one"));
  assertEquals(replacement.value(), undefined);
  first.set(true);
  assertEquals(replacement.expanded("record"), false);
  owner.retire("part:1");
  replacement.set(true);
  assertEquals(
    owner.disclosure("part:1", owner.generation("one")).value(),
    undefined,
  );
});

Deno.test("required rows override only category defaults, not explicit reader choices", () => {
  const owner = createTranscriptInteraction();
  const group = owner.disclosure("work:failure", "one");
  assertEquals(group.expanded("work", { expandWork: false }, true), true);
  group.set(false);
  assertEquals(group.expanded("work", { expandWork: true }, true), false);
  const compaction = owner.disclosure("compaction", "one");
  assertEquals(
    compaction.expanded("compaction", { expandCompaction: true }),
    true,
  );
  compaction.set(false);
  assertEquals(
    compaction.expanded("compaction", { expandCompaction: true }),
    false,
  );
  const completed = {
    tool: "external" as const,
    name: "fixture/execute",
    summary: "Run",
    callID: "one",
    status: "completed" as const,
    time: {},
  };
  assertEquals(toolFailure(completed), undefined);
  for (
    const message of [
      "Command timed out",
      "Command killed",
      "Command cancelled",
      "",
    ]
  ) {
    assertEquals(
      toolFailure({ ...completed, failure: { message } }),
      message || "Failed",
    );
  }
  assertEquals(
    toolFailure({ ...completed, failure: { message: "Nested call failed" } }),
    "Nested call failed",
  );
  assertEquals(
    toolFailure({ ...completed, status: "error", error: "Exact cause" }),
    "Exact cause",
  );
  assertEquals(toolFailure({ ...completed, status: "denied" }), "Denied");
  assertEquals(
    toolFailure({
      ...completed,
      tool: "bash",
      command: "exit 7",
      output: "",
      exitCode: 7,
    }),
    "Exited with code 7",
  );
});
