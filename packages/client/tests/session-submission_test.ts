// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  createInbox,
  createSessionDelivery,
  createSessionSubmission,
  createTabs,
  createTranscriptProjection,
  type InboxRpc,
  IntentGroup,
  RequestTracker,
  type TabInput,
} from "@otk/client";
import type { TranscriptOwner } from "../transcript.ts";
import type { RequestControl, TaskRecord } from "@otk/protocol";

function delivery(sessionID = "original", messageID = "submitted") {
  const projection = createTranscriptProjection();
  projection.merge([{
    id: messageID,
    sessionID,
    role: "user",
    time: { created: 1 },
    parts: [],
  }]);
  return createSessionDelivery({
    target: { sidecarId: "server", sessionID },
    title: () => "Submission",
    transcript: () =>
      ({
        projection,
        state: { clock: { epoch: "source", seq: 1 } },
        subscribe: () => () => {},
        pin: () => () => {},
      }) as unknown as TranscriptOwner,
    clock: { set() {}, clear() {} },
  });
}
const receipt = { messageID: "submitted", state: "accepted" as const };

Deno.test("composed Send dispatches under the fresh welcome after restart during admission", async () => {
  const sent: RequestControl[] = [];
  let current = "old-window";
  const tracker = new RequestTracker({
    send(frame) {
      sent.push(frame);
      if (frame.t !== "request") return;
      if (frame.ref.window !== current) {
        tracker.receive({
          t: "request.rejected",
          ref: frame.ref,
          error: {
            code: "request.expired",
            retry: "none",
            diagnosticID: "retired",
          },
        });
        return;
      }
      tracker.receive({
        t: "request.accepted",
        ref: frame.ref,
        seq: 0,
        acceptedAt: Date.now(),
        retentionUntil: Date.now() + 100000,
        replayed: false,
      });
      tracker.receive({
        t: "request.result",
        ref: frame.ref,
        seq: 1,
        outcome: {
          ok: true,
          result: { messageID: "composed", state: "accepted" },
        },
      });
    },
    kind: () => "mutation",
  });
  tracker.connect({ id: current, expiresAt: Date.now() + 100000 }, 8);
  const directory = Promise.withResolvers<string>();
  const submit = createSessionSubmission({
    sessionID: "opcv2-ses_composed",
    delivery: delivery("opcv2-ses_composed", "composed"),
    group: () => new IntentGroup(tracker.intent()),
    directory: () => directory.promise,
    tabs: () => ({ send: (_id, action) => action() }),
    inbox: { act: (_directory, action) => action() },
  });
  const send = submit((options) =>
    tracker.start("session.prompt", {
      sessionID: "opcv2-ses_composed",
      mode: "normal",
      parts: [{ kind: "text", text: "Composed before restart" }],
    }, options).result
  );
  assertEquals(sent, []);
  tracker.disconnect();
  current = "fresh-window";
  tracker.connect({ id: current, expiresAt: Date.now() + 100000 }, 8);
  directory.resolve("/original");
  assertEquals(await send, { kind: "committed", messageID: "composed" });
  assertEquals(
    sent.filter((frame) => frame.t === "request").map((frame) =>
      frame.ref.window
    ),
    [current],
  );
  tracker.stop();
});

function fixture() {
  const calls: unknown[] = [];
  const input: TabInput = {
    directory: "/original",
    entries: [],
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
    },
  };
  let failPromotion = false;
  const rpc: InboxRpc = {
    call(method, params) {
      calls.push([method, params]);
      if (method === "tasks.create") {
        if (failPromotion) return Promise.reject(new Error("Cannot promote"));
        const task: TaskRecord = {
          id: "task",
          directory: "/original",
          name: "Original session",
          sessions: ["original"],
          order: 0,
        };
        return Promise.resolve(task) as never;
      }
      return Promise.resolve(null) as never;
    },
  };
  const inbox = createInbox(rpc);
  const tabs = createTabs(inbox.promote, undefined, {
    input: () => input,
    session: (id) =>
      Promise.resolve({
        id,
        directory: "/original",
        title: "Original session",
      }),
  });
  return {
    calls,
    input,
    inbox,
    tabs,
    failPromotion: (value: boolean) => failPromotion = value,
  };
}

Deno.test("session submission waits for directory resolution and shares promotion without metadata delivery", async () => {
  const f = fixture(), directory = Promise.withResolvers<string>();
  const submit = createSessionSubmission({
    sessionID: "original",
    delivery: delivery(),
    directory: () => directory.promise,
    inbox: f.inbox,
    tabs: (value) => {
      assertEquals(value, "/original");
      return f.tabs;
    },
  });
  const action = () => {
    f.calls.push("submitted to original");
    return Promise.resolve(receipt);
  };
  const first = submit(action), second = submit(action);
  assertEquals(f.calls, []);
  directory.resolve("/original");
  assertEquals(await Promise.all([first, second]), [{
    kind: "committed",
    messageID: "submitted",
  }, { kind: "committed", messageID: "submitted" }]);
  assertEquals(f.calls, [
    ["tasks.create", {
      directory: "/original",
      name: "Original session",
      sessions: ["original"],
    }],
    "submitted to original",
    "submitted to original",
    ["projects.visit", { directory: "/original", active: true }],
    ["projects.visit", { directory: "/original", active: true }],
  ]);
  assertEquals(f.tabs.state.selected, { kind: "task", id: "task" });
  assertEquals(
    f.input.inbox.tasks,
    [],
    "Broadcast delivery is not an admission prerequisite",
  );
});

Deno.test("session submission cannot admit or record a visit after failed promotion and can retry", async () => {
  const f = fixture();
  const submit = createSessionSubmission({
    sessionID: "original",
    delivery: delivery(),
    directory: () => Promise.resolve("/original"),
    inbox: f.inbox,
    tabs: () => f.tabs,
  });
  f.failPromotion(true);
  let admitted = 0;
  const action = () => {
    admitted++;
    return Promise.resolve(receipt);
  };
  assertEquals((await submit(action)).kind, "refused");
  assertEquals(admitted, 0);
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "tasks.create",
  ]);
  f.failPromotion(false);
  assertEquals(await submit(action), {
    kind: "committed",
    messageID: "submitted",
  });
  assertEquals(admitted, 1);
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "tasks.create",
    "tasks.create",
    "projects.visit",
  ]);
});

Deno.test("session submission preserves action errors without visits and retries without duplicating its task", async () => {
  const f = fixture();
  const submit = createSessionSubmission({
    sessionID: "original",
    delivery: delivery(),
    directory: () => Promise.resolve("/original"),
    inbox: f.inbox,
    tabs: () => f.tabs,
  });
  assertEquals(
    (await submit(() => Promise.reject(new Error("Native rejection")))).kind,
    "refused",
  );
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "tasks.create",
  ]);
  assertEquals(await submit(() => Promise.resolve(receipt)), {
    kind: "committed",
    messageID: "submitted",
  });
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "tasks.create",
    "projects.visit",
  ]);
});

Deno.test("session submission propagates directory failure before creating a task or calling its action", async () => {
  const f = fixture();
  const submit = createSessionSubmission({
    sessionID: "original",
    delivery: delivery(),
    directory: () => Promise.reject(new Error("No directory")),
    inbox: f.inbox,
    tabs: () => f.tabs,
  });
  let admitted = false;
  const outcome = await submit(() => {
    admitted = true;
    return Promise.resolve(receipt);
  });
  assertEquals(outcome.kind, "refused");
  assertEquals(admitted, false);
  assertEquals(f.calls, []);
});
