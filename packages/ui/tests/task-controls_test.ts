// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  CommandHub,
  createTabs,
  type TabInput,
  type TaskActions,
} from "@otk/client";
import { createTaskControls } from "../features/task-controls.ts";

function project(directory: string) {
  const calls: unknown[] = [];
  const input: TabInput = {
    directory,
    entries: [],
    inbox: {
      projects: [],
      tasks: ["Plan", "Build"].map((name, order) => ({
        id: name.toLowerCase(),
        directory,
        name,
        order,
        sessions: [],
      })),
      seen: {},
      finishes: {},
      pathTemplates: [],
    },
  };
  const model = createTabs(
    (session) => {
      calls.push(["pin", session.id]);
      return Promise.resolve({
        id: "pinned",
        directory,
        name: session.title,
        order: 2,
        sessions: [session.id],
      });
    },
    undefined,
    {
      input: () => input,
      session: (id) =>
        Promise.resolve({ id, directory, title: "Session title" }),
    },
  );
  const actions: TaskActions = {
    create(name) {
      calls.push(["create", name]);
      const task = { id: "new", directory, name, order: 2, sessions: [] };
      input.inbox.tasks.push(task);
      return Promise.resolve(task);
    },
    rename(id, name) {
      calls.push(["rename", id, name]);
      return Promise.resolve();
    },
    reorder(ids) {
      calls.push(["reorder", ids]);
      input.inbox.tasks = ids.map((id, order) => ({
        ...input.inbox.tasks.find((t) => t.id === id)!,
        order,
      }));
      return Promise.resolve();
    },
    close(id) {
      calls.push(["close", id]);
      return Promise.resolve();
    },
    add(task, id) {
      calls.push(["add", task.id, id]);
      return Promise.resolve();
    },
  };
  return { calls, input, model, actions };
}
type Editor = {
  id: string;
  input: { name?: string; save(name: string): Promise<void> };
};
function fixture() {
  const first = project("/first"),
    second = project("/second"),
    commands = new CommandHub();
  let current = first, editor!: Editor, emptyAllowed = true, navigations = 0;
  commands.register({
    id: "dialog.open",
    title: "Open dialog",
    category: "Dialogs",
    run: (_ctx, input: Editor) => {
      editor = input;
    },
  });
  const controls = createTaskControls({
    commands,
    actions: () => current.actions,
    model: () => current.model,
    tasks: () => current.input.inbox.tasks,
    onEmpty: () => {
      navigations++;
      return emptyAllowed;
    },
  });
  return {
    first,
    second,
    controls,
    editor: () => editor,
    select: (value: typeof first) => {
      current = value;
    },
    block: () => {
      emptyAllowed = false;
    },
    navigations: () => navigations,
  };
}

Deno.test("task handlers retain pin, rename dialog/save, add, close and both move boundaries without menus", async () => {
  const f = fixture(), [plan, build] = f.first.input.inbox.tasks;
  const pinned = await f.controls.pin("session");
  assertEquals(pinned.sessions, ["session"]);
  await f.controls.rename(plan);
  assertEquals([f.editor().id, f.editor().input.name], ["task-name", "Plan"]);
  await f.editor().input.save("Renamed");
  await f.controls.move({ task: plan, delta: -1 });
  await f.controls.move({ task: build, delta: 1 });
  assertEquals(
    f.first.calls.length,
    2,
    "Boundary moves must not issue a mutation",
  );
  await f.controls.move({ task: build, delta: -1 });
  await f.controls.move({ task: build, delta: 1 });
  await f.controls.add({ task: plan, sessionID: "extra" });
  await f.controls.close(build.id);
  assertEquals(f.first.calls, [
    ["pin", "session"],
    ["rename", "plan", "Renamed"],
    ["reorder", ["build", "plan"]],
    ["reorder", ["plan", "build"]],
    ["add", "plan", "extra"],
    ["close", "build"],
  ]);
});

Deno.test("task editor saves retain their project and never navigate a replacement model", async () => {
  const f = fixture(), plan = f.first.input.inbox.tasks[0];
  await f.controls.rename(plan);
  const rename = f.editor();
  f.select(f.second);
  await rename.input.save("First project name");
  assertEquals(f.first.calls, [["rename", "plan", "First project name"]]);
  assertEquals(f.second.calls, []);
  await f.controls.rename();
  assertEquals(f.editor().input.name, undefined);
  const create = f.editor();
  f.select(f.first);
  await create.input.save("Second project task");
  assertEquals(f.second.calls, [["create", "Second project task"]]);
  assertEquals(f.first.model.state.selected, undefined);
  assertEquals(f.second.model.state.selected, undefined);
  assertEquals(f.navigations(), 0);
});

Deno.test("new task selection follows successful guarded navigation and rechecks ownership after an async save", async () => {
  const f = fixture();
  await f.controls.rename();
  await f.editor().input.save("Selected task");
  assertEquals(f.first.model.state.selected, { kind: "task", id: "new" });
  f.select(f.second);
  f.block();
  await f.controls.rename();
  await f.editor().input.save("Guarded task");
  assertEquals(f.second.model.state.selected, undefined);
  const g = fixture(), original = g.first.actions.create;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  g.first.actions.create = async (name) => {
    await pending;
    return await original(name);
  };
  await g.controls.rename();
  const saved = g.editor().input.save("Delayed first project task");
  g.select(g.second);
  release();
  await saved;
  assertEquals(g.first.calls, [["create", "Delayed first project task"]]);
  assertEquals(g.first.model.state.selected, undefined);
  assertEquals(g.second.model.state.selected, undefined);
  assertEquals(g.navigations(), 0);
});
