// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createDrafts,
  createRevertRecordProjection,
  createSessionRevert,
  createState,
  createTranscriptProjection,
  emptyContent,
  type SessionState,
} from "@otk/client";
import type { Message } from "@otk/protocol";
const row = (id: string, at: number): Message => ({
  id,
  sessionID: "s",
  role: "user",
  time: { created: at },
  parts: [],
});
Deno.test("revert display anchors one fixed group before later activity without changing live ownership", () => {
  const live = createTranscriptProjection(),
    display = createRevertRecordProjection();
  live.reset([row("earlier", 1), row("later", 4)]);
  const state = {
    phase: "saved" as const,
    record: {
      boundaryID: "boundary",
      messageIDs: ["boundary", "reply"],
      files: [],
    },
    messages: [row("boundary", 2), row("reply", 3)],
  };
  const value = display(live.state, state);
  assertEquals(value.keys, ["earlier", "revert:boundary", "later"]);
  assertEquals(value.groups["revert:boundary"].members, ["boundary", "reply"]);
  assertEquals(live.state.messageIDs, ["earlier", "later"]);
  assertEquals(
    display(live.state, { ...state, dismissed: true }).keys,
    value.keys,
  );
  assertEquals(display(live.state, {}).keys, live.state.records.keys);
});
Deno.test("confirmation snapshots framework-bound message DTOs without cloning their proxies", async () => {
  const session = createState<SessionState>({
    selection: { sidecarId: "local", sessionID: "s" },
    content: { ...emptyContent(), messages: [new Proxy(row("p", 1), {})] },
    loading: false,
    paging: false,
    exhausted: true,
    continuity: "ready",
  });
  const owner = createSessionRevert({
    session,
    drafts: createDrafts(),
    actions: {
      revert: () => {
        throw new Error("Confirmation sent a mutation");
      },
      restore: () => {
        throw new Error("No restore");
      },
      abort: () => Promise.resolve(),
    },
    status: { working: () => false, subscribe: () => () => {} },
  });
  await owner.revertTo("p");
  assertEquals(owner.state.phase, "confirming");
  assertEquals(owner.state.messages?.map((m) => m.id), ["p"]);
  owner.dispose();
});

Deno.test("an invocation-current empty draft can refill after command editing without discarding edited content", () => {
  const drafts = createDrafts(), write = drafts.writer("local/s");
  write((draft) => ({ ...draft, input: "Prior draft" }));
  const first = drafts.reverts.capture("local/s");
  first.staged("p");
  first.recall({ input: "First recalled", chips: [], mode: "normal" });
  write((draft) => ({ ...draft, input: "/undo" }));
  write((draft) => ({ ...draft, input: "" }));
  const second = drafts.reverts.capture("local/s", "p");
  second.staged("earlier");
  second.recall({ input: "Earlier recalled", chips: [], mode: "normal" });
  assertEquals(drafts.current("local/s").input, "Earlier recalled");
  assertEquals(drafts.reverts.get("local/s")?.before.input, "Prior draft");
});
