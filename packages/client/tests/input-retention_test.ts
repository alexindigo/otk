// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createDrafts, createInputGuard, emptyDraft } from "@otk/client";

Deno.test("unmounted request input stays with its owner until an accepted destructive release commits", async () => {
  let deleted = false, allowed = false, discarded = 0;
  const guard = createInputGuard({
    drafts: createDrafts(),
    key: () => "one",
    confirm: () => allowed,
    ...{
      retention: () =>
        deleted
          ? {
            owners: ["permissions"],
            inputs: [{ owner: "permissions", value: "Keep unsent feedback" }],
            discard: () => {
              discarded++;
            },
          }
          : undefined,
    },
  });
  guard.mark("permissions", true, "Keep unsent feedback");
  guard.mark("permissions", false); // Native retirement can unmount before index deletion.
  deleted = true;
  assertEquals(guard.retained(), [{
    owner: "permissions",
    value: "Keep unsent feedback",
  }]);
  assertEquals(guard.release(), true);
  assertEquals(await guard.release({ draft: "dropped" }), false);
  assertEquals(discarded, 0);
  allowed = true;
  const discard = await guard.release({ draft: "dropped" });
  if (!discard) throw new Error("Expected consent");
  assertEquals(discarded, 0);
  deleted = false;
  guard.clear();
  assertEquals(discarded, 0); // An intervening navigation cannot consume it.
  discard();
  assertEquals(discarded, 1);
});

Deno.test("release of another draft cannot consume current retained request input", async () => {
  const drafts = createDrafts();
  drafts.writer("other")({ ...emptyDraft(), input: "Other draft" });
  let discarded = 0;
  const guard = createInputGuard({
    drafts,
    key: () => "current",
    confirm: () => true,
    retention: () => ({
      owners: ["questions"],
      inputs: [{ owner: "questions", value: "Keep this" }],
      discard: () => {
        discarded++;
      },
    }),
  });
  const discard = await guard.release({ draft: "dropped", keys: ["other"] });
  if (!discard) throw new Error("Expected consent");
  discard();
  guard.clear();
  assertEquals(discarded, 0);
});

Deno.test("canonical request ownership excludes a stale mounted-view mirror after confirmed settlement", () => {
  let inputs = [{ owner: "permissions", value: "Submitted feedback" }];
  let confirmations = 0;
  const guard = createInputGuard({
    drafts: createDrafts(),
    key: () => "deleted",
    retain: () => true,
    confirm: () => {
      confirmations++;
      return false;
    },
    retention: () => ({ owners: ["permissions"], inputs, discard() {} }),
  });
  guard.mark("permissions", true, "Submitted feedback");
  guard.mark("permissions", false); // Deletion retained the old view mirror.
  inputs = []; // Canonical acknowledgment consumed the submitted value.
  assertEquals(guard.retained(), []);
  assertEquals(guard.dirty("permissions"), false);
  assertEquals(guard.release(), true);
  assertEquals(confirmations, 0);
});
