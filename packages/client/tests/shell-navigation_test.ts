// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import * as client from "@otk/client";
import {
  shellEntry,
  shellFixture,
  shellInfo,
  shellTask,
} from "./shell-fixture.ts";

const settled = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));
function fixture(hash = "#/local/selected") {
  const f = shellFixture(),
    drafts = client.createDrafts(),
    messages: string[] = [];
  let consent = true, listener: (() => void) | undefined, historyState: unknown;
  const location = { hash, pathname: "/app", search: "?a=1" },
    pushes: string[] = [];
  const environment: client.NavigationEnvironment = {
    location,
    history: {
      get state() {
        return historyState;
      },
      replaceState(value) {
        historyState = value;
      },
      pushState(value, _unused, url) {
        historyState = value;
        const text = String(url);
        pushes.push(text);
        const at = text.indexOf("#");
        location.hash = at < 0 ? "" : text.slice(at);
      },
      go() {},
    },
    listen(changed) {
      listener = changed;
      return () => {
        listener = undefined;
      };
    },
  };
  f.entries("local", [shellEntry("selected"), shellEntry("other")]);
  const actions = client.createSessionActions(f);
  const guard = client.createInputGuard({
    drafts,
    key: actions.key,
    confirm: (m) => {
      messages.push(m);
      return consent;
    },
  });
  const presence = { focused: true, visible: true };
  const navigation = client.createShellNavigation({
    ...f,
    actions,
    guard,
    environment,
    presence: () => presence,
  });
  navigation.start();
  f.calls.length = 0;
  return {
    ...f,
    drafts,
    actions,
    guard,
    navigation,
    presence,
    location,
    pushes,
    messages,
    consent(value: boolean) {
      consent = value;
    },
    external(next: string) {
      location.hash = next;
      listener?.();
    },
    stop() {
      navigation.stop();
      f.resources.stop();
      assertEquals(listener, undefined);
    },
  };
}

Deno.test("shell navigation owns route state, unknown-server errors, project visits and subscriptions", async () => {
  const f = fixture();
  let changes = 0;
  const release = f.navigation.subscribe(() => changes++);
  f.external("#project/local/%2Fempty");
  await settled();
  assertEquals(f.navigation.state.project, {
    sidecarId: "local",
    directory: "/empty",
  });
  assertEquals(f.session.state.selection, undefined);
  assertEquals(f.calls.filter((c) => c[1] === "projects.visit"), [[
    "local",
    "projects.visit",
    { directory: "/empty" },
  ]]);
  f.external("#/unknown/session");
  assertEquals(
    f.navigation.state.error,
    "The URL refers to an unknown server. Add it in Settings.",
  );
  assertEquals(f.navigation.state.project, undefined);
  assertEquals(f.session.state.selection, undefined);
  f.navigation.fail(new Error("plain failure"));
  assertEquals(f.navigation.state.error, "plain failure");
  f.navigation.clearError();
  assertEquals(f.navigation.state.error, "");
  assert(changes > 0);
  release();
  f.stop();
});
Deno.test("shell navigation confirms and clears dirty owners only on selection change", () => {
  const f = fixture();
  f.guard.mark("permissions", true);
  f.consent(false);
  assertEquals(
    f.navigation.navigate({
      sidecarId: "local",
      sessionID: "selected",
      rootID: "hint",
    }),
    true,
  );
  assertEquals(f.messages, []);
  assertEquals(f.guard.dirty("permissions"), true);
  assertEquals(
    f.navigation.navigate({ sidecarId: "local", sessionID: "other" }),
    false,
  );
  assertEquals(f.guard.dirty("permissions"), true);
  f.consent(true);
  assertEquals(
    f.navigation.navigate({ sidecarId: "local", sessionID: "other" }),
    true,
  );
  assertEquals(f.guard.dirty("permissions"), false);
  f.stop();
});
Deno.test("shell navigation normalizes roots and same-session reselection visits without another push", async () => {
  const f = fixture();
  f.entries("local", [
    shellEntry("root"),
    shellEntry("middle", "/p", "root"),
    shellEntry("leaf", "/p", "middle"),
  ]);
  assert(
    f.navigation.navigate({
      sidecarId: "local",
      sessionID: "leaf",
      rootID: "middle",
    }),
  );
  assertEquals(f.location.hash, "#/local/root/leaf");
  const count = f.pushes.length;
  assert(f.navigation.navigate({ sidecarId: "local", sessionID: "leaf" }));
  await settled();
  assertEquals(f.pushes.length, count);
  assertEquals(f.calls.filter((c) => c[1] === "sessions.seen"), [[
    "local",
    "sessions.seen",
    { sessionID: "leaf" },
  ]]);
  f.navigation.openChild("unknown");
  assertEquals(f.location.hash, "#/local/root/unknown");
  f.stop();
});
Deno.test("shell navigation opens existing project roots or project-only hashes and home", async () => {
  const f = fixture();
  f.navigation.showSettings();
  f.navigation.openProject({ sidecarId: "local", directory: "/empty" });
  assertEquals(f.location.hash, "#project/local/%2Fempty");
  assertEquals(f.navigation.state.settings, false);
  f.navigation.openProject({ sidecarId: "local", directory: "/p" });
  assertEquals(f.location.hash, "#/local/selected");
  f.navigation.showSettings();
  const count = f.pushes.length;
  f.navigation.openProject({ sidecarId: "local", directory: "/p" });
  assertEquals(f.pushes.length, count);
  assertEquals(f.navigation.state.settings, false);
  assertEquals(f.navigation.projectHome(), true);
  assertEquals(f.location.hash, "#project/local/%2Fp");
  await settled();
  f.stop();
});
Deno.test("shell navigation refuses create and removal when input release is cancelled", async () => {
  const f = fixture();
  f.drafts.writer(f.actions.key())({
    ...client.emptyDraft(),
    editor: { text: "keep" },
  });
  f.consent(false);
  await f.navigation.createIn("local", "/p");
  assertEquals(f.calls, []);
  assertEquals(f.navigation.removeServer("local"), false);
  assertEquals(f.calls, []);
  f.consent(true);
  assertEquals(f.navigation.removeServer("local"), true);
  assertEquals(f.calls.at(-1), ["remove", "local"]);
  f.stop();
});
for (const rejected of [false, true]) {
  Deno.test(`shell navigation later intent supersedes pending creation ${rejected ? "failure" : "success"}`, async () => {
    const f = fixture(), held = Promise.withResolvers<unknown>();
    f.reply((_id, method) =>
      method === "session.create" ? held.promise : Promise.resolve(null)
    );
    const creating = rejected
      ? f.navigation.createIn("local", "/p")
      : f.navigation.create({ sidecarId: "local", directory: "/p" });
    f.navigation.navigate({ sidecarId: "local", sessionID: "other" });
    if (rejected) held.reject(new Error("old failure"));
    else held.resolve(shellInfo("created"));
    await creating;
    assertEquals(f.session.state.selection?.sessionID, "other");
    assertEquals(f.navigation.state.error, "");
    assertEquals(f.calls.filter((c) => c[0] === "open").length, 1);
    f.stop();
  });
}
Deno.test("shell navigation create-in-task captures the owning task action before awaiting creation", async () => {
  const f = fixture(), held = Promise.withResolvers<unknown>();
  f.reply((_id, method) =>
    method === "session.create" ? held.promise : Promise.resolve(null)
  );
  const creating = f.navigation.createIn(
    "remote",
    "/remote",
    shellTask("task", ["old"], "/remote"),
  );
  f.resources.taskActions = () => {
    throw new Error("must use captured actions");
  };
  held.resolve(shellInfo("created", "/remote"));
  await creating;
  assertEquals(f.calls.slice(0, 2), [["remote", "session.create", {
    directory: "/remote",
  }], ["remote", "tasks.addSession", { id: "task", sessionID: "created" }]]);
  assertEquals(f.location.hash, "#/remote/created");
  f.stop();
});
Deno.test("shell navigation create resolves current directory but drops on settings revision change", async () => {
  const f = fixture(), held = Promise.withResolvers<unknown>();
  f.entries("local", []);
  f.session.state.info = undefined;
  f.reply((_id, method) =>
    method === "session.get" ? held.promise : Promise.resolve(null)
  );
  assertEquals(f.navigation.available(), true);
  const creating = f.navigation.create();
  f.navigation.showSettings();
  held.resolve(shellInfo("selected", "/resolved"));
  await creating;
  assertEquals(f.calls, [["local", "session.get", { sessionID: "selected" }]]);
  f.navigation.closeSettings();
  assertEquals(f.navigation.state.settings, false);
  f.servers.update((s) => {
    s.list[0].status = "reconnecting";
  });
  assertEquals(
    f.navigation.available({ sidecarId: "local", directory: "/p" }),
    false,
  );
  f.stop();
});
Deno.test("shell navigation first-view and finish seen rules observe readiness, presence and deselection", async () => {
  const f = fixture(), selected = { sidecarId: "local", sessionID: "selected" };
  const view = {
    selected,
    directory: "/p",
    loading: false,
    settings: false,
    connected: true,
    finish: 1,
  };
  for (
    const invalid of [{ loading: true }, { settings: true }, {
      connected: false,
    }, { directory: undefined }]
  ) f.navigation.observeView({ ...view, ...invalid });
  assertEquals(f.calls, []);
  f.presence.focused = false;
  f.presence.visible = false;
  f.navigation.observeView(view);
  await settled();
  assertEquals(f.calls, [["local", "projects.visit", { directory: "/p" }], [
    "local",
    "sessions.seen",
    { sessionID: "selected" },
  ]]);
  f.calls.length = 0;
  f.navigation.observeView({ ...view, finish: 2 });
  f.presence.focused = true;
  f.navigation.observeView({ ...view, finish: 2 });
  assertEquals(f.calls, []);
  f.presence.visible = true;
  f.navigation.observeView({ ...view, finish: 2 });
  f.navigation.observeView({ ...view, finish: 2 });
  await settled();
  assertEquals(f.calls, [["local", "sessions.seen", {
    sessionID: "selected",
  }]]);
  f.calls.length = 0;
  f.navigation.observeView({ ...view, selected: undefined });
  f.navigation.observeView(view);
  await settled();
  assertEquals(f.calls.length, 2);
  f.stop();
});
Deno.test("shell navigation preview and pin share guarded target transitions and avoid duplicate helper tasks", async () => {
  const f = fixture();
  f.entries("local", [
    shellEntry("selected"),
    shellEntry("helper", "/p", "selected"),
  ]);
  f.resources.inbox("local").state.inbox.tasks = [
    shellTask("existing", ["selected"]),
  ];
  assertEquals(
    f.navigation.preview({ sidecarId: "local", sessionID: "helper" }),
    true,
  );
  assertEquals(
    await f.navigation.pin({ sidecarId: "local", sessionID: "helper" }),
    true,
  );
  assertEquals(f.calls.some((c) => c[1] === "tasks.create"), false);
  assertEquals(
    await f.navigation.pin({ sidecarId: "local", sessionID: "missing" }),
    false,
  );
  await settled();
  f.stop();
});
