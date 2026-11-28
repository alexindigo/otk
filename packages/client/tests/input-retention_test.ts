// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createDrafts,
  createInputGuard,
  emptyDraft,
  RequestLifetimes,
} from "@otk/client";

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

Deno.test("deleted Close hands off exact request input without prompting, then Recover and X keep single custody", async () => {
  const drafts = createDrafts();
  const prior = {
    ...emptyDraft(),
    input: "Stored draft",
    editor: { text: "  Unsaved editor text\nsecond line\n" },
  };
  drafts.writer("deleted")(prior);
  const requests = new RequestLifetimes();
  const entry = () => ({ parentID: undefined, deleted: true });
  const input = "  Unsent reason\nsecond line\n";
  requests.receive({
    op: "permission.upsert",
    request: {
      id: "p",
      sessionID: "deleted",
      kind: "read",
      title: "Read",
      patterns: [],
      alwaysPatterns: [],
      detail: { kind: "generic", summary: "Read" },
      time: 1,
    },
  });
  requests.draft("permission", "p", input);
  requests.retireSessions(() => true);
  let prompts = 0;
  const guard = createInputGuard({
    drafts,
    key: () => "deleted",
    confirm: () => (++prompts, false),
    retention: () => requests.retention("deleted", entry),
    transferDeleted: (park) => requests.transferDeleted("deleted", entry, park),
  });
  const observations: unknown[] = [];
  drafts.subscribe(() => {
    observations.push(requests.draft("permission", "p"));
  });
  requests.subscribe(() => {
    observations.push(drafts.recoveries("deleted").map(({ draft }) => draft));
  });
  guard.keepDeleted();
  assertEquals(prompts, 0);
  assertEquals(guard.retained(), []);
  const kept = { ...emptyDraft(), input };
  assertEquals(observations, [undefined, [kept, prior]]);
  assertEquals(drafts.current("deleted"), emptyDraft());
  assertEquals(
    await guard.release({ draft: "dropped", keys: ["other"] }) !== false,
    true,
  );
  assertEquals(prompts, 0);
  assertEquals(
    await guard.release({ draft: "dropped", keys: ["deleted"] }),
    false,
  );
  assertEquals(prompts, 1);

  const [recover, discard] = drafts.recoveries("deleted");
  recover.run();
  recover.discard(); // Stale action cannot discard current text.
  discard.discard();
  assertEquals(drafts.current("deleted").input, input);
  assertEquals(drafts.recoveries("deleted"), []);
  guard.keepDeleted();
  guard.keepDeleted();
  assertEquals(prompts, 1);
  assertEquals(drafts.current("deleted"), emptyDraft());
  assertEquals(drafts.recoveries("deleted").map(({ draft }) => draft), [kept]);
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
