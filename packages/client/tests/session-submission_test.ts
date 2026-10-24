// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  createInbox,
  createSessionSubmission,
  createTabs,
  type InboxRpc,
  type TabInput,
} from "@otk/client";
import type { TaskRecord } from "@otk/protocol";

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
    directory: () => directory.promise,
    inbox: f.inbox,
    tabs: (value) => {
      assertEquals(value, "/original");
      return f.tabs;
    },
  });
  const action = () => {
    f.calls.push("submitted to original");
    return Promise.resolve(42);
  };
  const first = submit(action), second = submit(action);
  assertEquals(f.calls, []);
  directory.resolve("/original");
  assertEquals(await Promise.all([first, second]), [42, 42]);
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
    directory: () => Promise.resolve("/original"),
    inbox: f.inbox,
    tabs: () => f.tabs,
  });
  f.failPromotion(true);
  let admitted = 0;
  const action = () => Promise.resolve(++admitted);
  await assertRejects(() => submit(action), Error, "Cannot promote");
  assertEquals(admitted, 0);
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "tasks.create",
  ]);
  f.failPromotion(false);
  assertEquals(await submit(action), 1);
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
    directory: () => Promise.resolve("/original"),
    inbox: f.inbox,
    tabs: () => f.tabs,
  });
  await assertRejects(
    () => submit(() => Promise.reject(new Error("Native rejection"))),
    Error,
    "Native rejection",
  );
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "tasks.create",
  ]);
  assertEquals(await submit(() => Promise.resolve("accepted")), "accepted");
  assertEquals(f.calls.map((value) => (value as unknown[])[0]), [
    "tasks.create",
    "projects.visit",
  ]);
});

Deno.test("session submission propagates directory failure before creating a task or calling its action", async () => {
  const f = fixture();
  const submit = createSessionSubmission({
    sessionID: "original",
    directory: () => Promise.reject(new Error("No directory")),
    inbox: f.inbox,
    tabs: () => f.tabs,
  });
  let admitted = false;
  await assertRejects(
    () =>
      submit(() => {
        admitted = true;
        return Promise.resolve();
      }),
    Error,
    "No directory",
  );
  assertEquals(admitted, false);
  assertEquals(f.calls, []);
});
