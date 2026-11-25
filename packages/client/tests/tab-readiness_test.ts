// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  createInbox,
  createTabs,
  type InboxRpc,
  type TabInput,
} from "@otk/client";
import type { IndexEntry, TaskRecord } from "@otk/protocol";

type Session = Pick<IndexEntry, "id" | "directory" | "title">;
const session = (id: string): Session => ({ id, directory: "/p", title: id });
const entry = (id: string): IndexEntry => ({
  ...session(id),
  projectID: "p",
  timeCreated: 1,
  timeUpdated: 1,
  archived: false,
  status: "busy",
  digest: { state: "digesting", revision: 0, turns: {} },
  attention: {
    permissions: 0,
    questions: 0,
    childPermissions: 0,
    childQuestions: 0,
  },
});
const task = (id: string): TaskRecord => ({
  id: `task-${id}`,
  directory: "/p",
  name: id,
  order: 0,
  sessions: [id],
});
function input(): TabInput {
  return {
    directory: "/p",
    entries: [],
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
    },
  };
}
function model(
  promote: (session: Session) => Promise<TaskRecord>,
  sources: { input(): TabInput; session(id: string): Promise<Session> },
): ReturnType<typeof createTabs> {
  return createTabs(promote, undefined, sources);
}

Deno.test("tab readiness: explicit pin resolves new identity before any index insertion", async () => {
  const calls: string[] = [], current = input();
  const rpc: InboxRpc = {
    call(method) {
      calls.push(method);
      if (method === "tasks.create") {
        return Promise.resolve(task("new")) as never;
      }
      if (method === "session.get") {
        return Promise.resolve(session("new")) as never;
      }
      return Promise.resolve("sent") as never;
    },
  };
  const inbox = createInbox(rpc);
  const tabs = model(inbox.promote, {
    input: () => current,
    session: (sessionID) => rpc.call("session.get", { sessionID }),
  });
  tabs.update(current);
  assertEquals(await tabs.pin("new"), task("new"));
  assertEquals(calls, ["session.get", "tasks.create"]);
  assertEquals(current.entries, []);
  assertEquals(tabs.state.selected, { kind: "task", id: "task-new" });
  current.entries = [entry("new")];
  current.inbox.tasks = [task("new")];
  tabs.update(current);
  assertEquals(tabs.tabs().map((t) => [t.kind, t.id]), [["task", "task-new"]]);
  assertEquals(tabs.state.sessionID, "new");
});

Deno.test("tab readiness: preview and task selection read current sources before a deferred view update", () => {
  let current = input();
  const tabs = model(() => Promise.resolve(task("new")), {
    input: () => current,
    session: (id) => Promise.resolve(session(id)),
  });
  tabs.update(current);
  current = { ...current, entries: [entry("new"), entry("other")] };
  tabs.preview("new");
  assertEquals(tabs.state.preview, "new");
  current = { ...current, inbox: { ...current.inbox, tasks: [task("new")] } };
  tabs.select({ kind: "task", id: "task-new" });
  assertEquals(tabs.state.selected, { kind: "task", id: "task-new" });
  assertEquals(tabs.state.sessionID, "new");
  tabs.preview("other");
  assertEquals(tabs.state.preview, "other");
});

Deno.test("tab readiness: explicit pin and background persistence share resolution without stealing a newer preview", async () => {
  const current = input();
  current.entries = [entry("other")];
  let resolve!: (value: Session) => void, lookups = 0, promotions = 0;
  const tabs = model((s) => {
    promotions++;
    return Promise.resolve(task(s.id));
  }, {
    input: () => current,
    session: () => {
      lookups++;
      return new Promise<Session>((done) => resolve = done);
    },
  });
  tabs.update(current);
  const first = tabs.pin("new"),
    second = tabs.ensureTask("new");
  await Promise.resolve();
  tabs.preview("other");
  assertEquals(lookups, 1);
  resolve(session("new"));
  await first;
  assertEquals(await second, task("new"));
  assertEquals(promotions, 1);
  assertEquals(tabs.state.selected, { kind: "session", id: "other" });
});

Deno.test("tab readiness: project changes during resolution cannot move selection or promotion to another project", async () => {
  let current = input(), resolve!: (value: Session) => void;
  const promoted: Session[] = [];
  const tabs = model((s) => {
    promoted.push(s);
    return Promise.resolve(task(s.id));
  }, {
    input: () => current,
    session: () => new Promise<Session>((done) => resolve = done),
  });
  tabs.update(current);
  const pending = tabs.pin("new");
  await Promise.resolve();
  current = {
    ...input(),
    directory: "/q",
    entries: [{ ...entry("q"), directory: "/q" }],
  };
  tabs.preview("q");
  resolve(session("new"));
  await pending;
  assertEquals(promoted, [session("new")]);
  assertEquals(tabs.state.selected, { kind: "session", id: "q" });
});

Deno.test("tab readiness: failed or invalid metadata does not poison a later promotion", async () => {
  for (const invalid of ["id", "directory", "failure"]) {
    const current = input();
    let bad = true, promoted = 0;
    const tabs = model((s) => {
      promoted++;
      return Promise.resolve(task(s.id));
    }, {
      input: () => current,
      session: (id) => {
        if (bad && invalid === "failure") {
          return Promise.reject(new Error("offline"));
        }
        return Promise.resolve({
          ...session(id),
          ...(bad && invalid === "id" ? { id: "wrong" } : {}),
          ...(bad && invalid === "directory" ? { directory: "/q" } : {}),
        });
      },
    });
    tabs.update(current);
    const persist = () => tabs.ensureTask("new");
    await assertRejects(
      persist,
      Error,
      invalid === "failure" ? "offline" : "Unknown project session",
    );
    assertEquals(promoted, 0);
    bad = false;
    assertEquals(await persist(), task("new"));
    assertEquals(promoted, 1);
  }
});
