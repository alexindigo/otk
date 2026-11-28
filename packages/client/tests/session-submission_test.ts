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
  const admitted = Promise.withResolvers<void>();
  const submit = createSessionSubmission({
    sessionID: "opcv2-ses_composed",
    delivery: delivery("opcv2-ses_composed", "composed"),
    group: () => new IntentGroup(tracker.intent()),
    directory: () => directory.promise,
    tabs: () => ({ ensureTask: () => Promise.withResolvers<never>().promise }),
    inbox: { visit: () => Promise.resolve() },
    wrap: async (action) => {
      await admitted.promise;
      return await action();
    },
  });
  const send = submit((options, dispatch) => {
    dispatch();
    return tracker.start("session.prompt", {
      sessionID: "opcv2-ses_composed",
      mode: "normal",
      parts: [{ kind: "text", text: "Composed before restart" }],
    }, options).result;
  });
  assertEquals(sent, []);
  tracker.disconnect();
  current = "fresh-window";
  tracker.connect({ id: current, expiresAt: Date.now() + 100000 }, 8);
  directory.resolve("/original");
  admitted.resolve();
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

Deno.test("session submission dispatches while directory resolution and promotion are held", async () => {
  const f = fixture(), directory = Promise.withResolvers<string>();
  const promoting = Promise.withResolvers<void>();
  const promoted = Promise.withResolvers<TaskRecord>();
  const visited = Promise.withResolvers<void>();
  const submit = createSessionSubmission({
    sessionID: "original",
    delivery: delivery(),
    directory: () => directory.promise,
    inbox: {
      visit: () => {
        visited.resolve();
        return Promise.resolve();
      },
    },
    tabs: (value) => {
      assertEquals(value, "/original");
      return {
        ensureTask: () => {
          promoting.resolve();
          return promoted.promise;
        },
      };
    },
  });
  const action: Parameters<typeof submit>[0] = (_options, dispatch) => {
    dispatch();
    f.calls.push("submitted to original");
    return Promise.resolve(receipt);
  };
  const completed = submit(action);
  assertEquals(f.calls, ["submitted to original"]);
  directory.resolve("/original");
  await promoting.promise;
  assertEquals(await completed, { kind: "committed", messageID: "submitted" });
  await visited.promise;
  promoted.resolve({
    id: "task",
    directory: "/original",
    name: "Original",
    sessions: ["original"],
    order: 0,
  });
});

Deno.test("session submission reports failed promotion independently of native success and can retry pinning", async () => {
  const f = fixture();
  const reported = Promise.withResolvers<unknown>();
  const submit = createSessionSubmission({
    sessionID: "original",
    delivery: delivery(),
    directory: () => Promise.resolve("/original"),
    inbox: f.inbox,
    tabs: () => f.tabs,
    report: reported.resolve,
  });
  f.failPromotion(true);
  let admitted = 0;
  const action = () => {
    admitted++;
    return Promise.resolve(receipt);
  };
  assertEquals((await submit(action)).kind, "committed");
  assertEquals(admitted, 1);
  assertEquals((await reported.promise as Error).message, "Cannot promote");
  f.failPromotion(false);
  await f.tabs.pin("original");
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "projects.visit",
    "tasks.create",
    "tasks.create",
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
  assertEquals(f.calls, []);
  assertEquals(await submit(() => Promise.resolve(receipt)), {
    kind: "committed",
    messageID: "submitted",
  });
  await f.tabs.pin("original");
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "projects.visit",
    "tasks.create",
  ]);
});

Deno.test("session submission reports directory failure without dropping native Send", async () => {
  const f = fixture();
  const reported = Promise.withResolvers<unknown>();
  const submit = createSessionSubmission({
    sessionID: "original",
    delivery: delivery(),
    directory: () => Promise.reject(new Error("No directory")),
    inbox: f.inbox,
    tabs: () => f.tabs,
    report: reported.resolve,
  });
  let admitted = false;
  const outcome = await submit(() => {
    admitted = true;
    return Promise.resolve(receipt);
  });
  assertEquals(outcome.kind, "committed");
  assertEquals(admitted, true);
  assertEquals((await reported.promise as Error).message, "No directory");
  assertEquals(f.calls, []);
});
