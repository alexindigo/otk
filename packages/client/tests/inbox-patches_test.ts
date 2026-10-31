// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { InboxBaseline, InboxSnapshot } from "@otk/protocol";
import { createInbox, type InboxRpc } from "../inbox.ts";

const snapshot = (): InboxSnapshot => ({
  projects: [{
    directory: "/p",
    order: 0,
    added: true,
    inactive: false,
    lastVisit: 1,
  }],
  tasks: [{ id: "t", directory: "/p", name: "Kept", order: 0, sessions: [] }],
  seen: {},
  finishes: {},
  pathTemplates: [],
});
Deno.test("inbox patches preserve unrelated identities and coalesce gap recovery", async () => {
  let calls = 0, resolve!: (value: InboxBaseline) => void;
  const model = createInbox({
    call: () => {
      calls++;
      return new Promise<InboxBaseline>((yes) => {
        resolve = yes;
      });
    },
  } as InboxRpc);
  model.receive({
    t: "inbox.snapshot",
    generation: "a",
    revision: 0,
    inbox: snapshot(),
  });
  const task = model.state.inbox.tasks[0],
    project = model.state.inbox.projects[0];
  model.receive({
    t: "inbox.patch",
    generation: "a",
    from: 0,
    revision: 1,
    ops: [{ op: "seen", sessionID: "opcv1-ses_a", time: 10 }],
  });
  assertEquals(model.state.inbox.seen, { "opcv1-ses_a": 10 });
  assertStrictEquals(model.state.inbox.tasks[0], task);
  assertStrictEquals(model.state.inbox.projects[0], project);
  for (let i = 0; i < 10; i++) {
    model.receive({
      t: "inbox.patch",
      generation: "a",
      from: 4,
      revision: 5,
      ops: [{ op: "finish", sessionID: "opcv1-ses_a", time: 20 }],
    });
  }
  assertEquals(calls, 1);
  assertEquals(model.state.inbox.finishes, {});
  model.receive({
    t: "inbox.snapshot",
    generation: "a",
    revision: 6,
    inbox: { ...snapshot(), seen: { "opcv1-ses_a": 30 } },
  });
  resolve({ generation: "a", revision: 2, inbox: snapshot() });
  await new Promise((yes) => setTimeout(yes, 0));
  assertEquals(model.state.inbox.seen, { "opcv1-ses_a": 30 });
  assertEquals(
    calls,
    1,
    "A newer accepted baseline already covers this recovery",
  );
});

Deno.test("inbox reconnect accepts only its new baseline and fences retired recovery", async () => {
  let resolve!: (value: InboxBaseline) => void;
  const model = createInbox({
    call: () =>
      new Promise<InboxBaseline>((yes) => {
        resolve = yes;
      }),
  } as InboxRpc);
  model.receive({
    t: "inbox.snapshot",
    generation: "a",
    revision: 8,
    inbox: snapshot(),
  });
  model.receive({
    t: "inbox.patch",
    generation: "other",
    from: 8,
    revision: 9,
    ops: [{ op: "templates", values: ["old"] }],
  });
  // Welcome resets only transport authority; last-good metadata stays visible.
  model.receive({ t: "welcome" } as Parameters<typeof model.receive>[0]);
  model.receive({
    t: "inbox.snapshot",
    generation: "b",
    revision: 0,
    inbox: { ...snapshot(), pathTemplates: ["new"] },
  });
  resolve({ generation: "a", revision: 99, inbox: snapshot() });
  await new Promise((yes) => setTimeout(yes, 0));
  assertEquals(model.state.inbox.pathTemplates, ["new"]);
});

Deno.test("retired inbox recovery releases its read and cannot publish after server removal", async () => {
  let resolve!: (value: InboxBaseline) => void, signal: AbortSignal | undefined;
  const model = createInbox(
    {
      call: (_method: string, _params: unknown, input: AbortSignal) => {
        signal = input;
        return new Promise<InboxBaseline>((yes) => {
          resolve = yes;
        });
      },
    } as InboxRpc,
  );
  model.receive({
    t: "inbox.snapshot",
    generation: "a",
    revision: 0,
    inbox: snapshot(),
  });
  model.receive({
    t: "inbox.patch",
    generation: "a",
    from: 2,
    revision: 3,
    ops: [{ op: "templates", values: ["late"] }],
  });
  model.stop();
  assertEquals(signal?.aborted, true);
  resolve({
    generation: "a",
    revision: 3,
    inbox: { ...snapshot(), pathTemplates: ["late"] },
  });
  await new Promise((yes) => setTimeout(yes, 0));
  assertEquals(model.state.inbox.pathTemplates, []);
});
