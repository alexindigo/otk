// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { foldRecords, recordKindDisclosure } from "../record-folds.ts";
import { createTranscriptInteraction } from "../transcript-interaction.ts";
import type { Activity } from "@otk/protocol";
const marker: Activity = {
  kindLabel: "step",
  category: "stepMarkers",
  fold: true,
  title: "Step started",
  layout: "row",
  tone: "normal",
  summary: { kind: "step-marker", noun: "step marker", plural: "step markers" },
};
Deno.test("folded bookkeeping contributes counts but no rows, expanded retains chronology", () => {
  const items = [marker, { ...marker, fold: false }, {
    ...marker,
    title: "Step finished",
  }];
  const closed = foldRecords(items, (item) => item, () => false);
  assertEquals(closed.visible, [items[1]]);
  assertEquals(closed.folds, [{
    category: "stepMarkers",
    count: 2,
    label: "2 step markers",
  }]);
  assertEquals(foldRecords(items, (item) => item, () => true).visible, items);
  assertEquals(items.length, 3);
});
Deno.test("failure, active and unknown facts cannot be folded", () => {
  const items: Activity[] = [{ ...marker, tone: "error" }, {
    ...marker,
    state: {
      key: "running",
      label: "running",
      facts: { active: true, terminal: false },
    },
  }, {
    ...marker,
    state: {
      key: "unknown",
      label: "unknown",
      facts: { active: null, terminal: null },
    },
  }];
  assertEquals(foldRecords(items, (item) => item, () => false).visible, items);
});

Deno.test("an identical-record group contributes every native member to its count", () => {
  const grouped = [{ members: ["one", "two", "three"] }];
  assertEquals(
    foldRecords(
      grouped,
      () => marker,
      () => false,
      (item) => item.members.length,
    ).folds[0].label,
    "3 step markers",
  );
});

Deno.test("category reveal uses the frame generation and cannot revive a removed frame's choice", () => {
  const interaction = createTranscriptInteraction();
  const old = recordKindDisclosure(interaction, "frame", "stepMarkers");
  old.set(true);
  assertEquals(
    recordKindDisclosure(interaction, "frame", "stepMarkers").expanded(
      "stepMarkers",
    ),
    true,
  );
  assertEquals(
    recordKindDisclosure(interaction, "frame", "snapshots").expanded(
      "snapshots",
    ),
    false,
  );
  interaction.retireIdentity("frame");
  const next = recordKindDisclosure(interaction, "frame", "stepMarkers");
  assertEquals(next.expanded("stepMarkers"), false);
  old.set(true);
  assertEquals(next.expanded("stepMarkers"), false);
});
