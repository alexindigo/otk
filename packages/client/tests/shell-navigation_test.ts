// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import * as client from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import { fixtureRequests } from "../../../tests/support/request-wire.ts";
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import {
  shellEntry,
  shellFixture,
  shellInfo,
  shellTask,
} from "./shell-fixture.ts";

const settled = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

for (
  const path of [
    "sticky restore",
    "crumb navigation",
    "attention jump",
    "URL restore",
  ]
) {
  Deno.test(`2.67 shell ${path} preserves the helper destination without a helper task`, async () => {
    const f = fixture(
      path === "URL restore" ? "#/local/tstv1-selected/tstv1-helper" : "",
    );
    const project = { sidecarId: "local", directory: "/p" };
    try {
      f.entries("local", [
        shellEntry("tstv1-selected"),
        shellEntry("tstv1-helper", "/p", "tstv1-selected"),
      ]);
      f.resources.receive("local", {
        t: "inbox.snapshot",
        generation: "identity",
        revision: 0,
        summaryRevision: 0,
        inbox: {
          projects: [],
          tasks: [],
          seen: {},
          finishes: {},
          pathTemplates: [],
          supervision: { "tstv1-helper": { state: "working", terminal: 0 } },
        },
      });
      if (path === "attention jump") {
        f.resources.projectSession = () => Promise.resolve("tstv1-helper");
        f.navigation.openAttention(project);
      } else if (path !== "URL restore") {
        f.navigation.navigate({
          sidecarId: "local",
          sessionID: "tstv1-selected",
        });
        f.navigation.navigate({
          sidecarId: "local",
          sessionID: "tstv1-helper",
        });
        if (path === "sticky restore") {
          f.navigation.projectHome();
          f.navigation.openProject(project);
        }
      }
      await settled();
      f.resources.syncTabs(
        project,
        f.resources.tabSnapshot(project),
        f.session.state.selection,
      );
      const tabs = f.resources.tabs(project);
      assertEquals(f.session.state.selection?.sessionID, "tstv1-helper");
      assertEquals(tabs.state.selected, {
        kind: "session",
        id: "tstv1-selected",
      });
      assertEquals(tabs.tabs().map((tab) => tab.id), ["tstv1-selected"]);
      assertEquals(tabs.crumbs().map((crumb) => crumb.id), [
        "tstv1-selected",
        "tstv1-helper",
      ]);
    } finally {
      f.stop();
    }
  });
}

Deno.test("accepted project memory retries failed persistence on reconnect without changing the selection", async () => {
  const f = fixture("");
  let writes = 0;
  f.reply((_id, method) => {
    if (method === "layout.location" && ++writes === 1) {
      return Promise.reject(new Error("lost location write"));
    }
    return Promise.resolve(null);
  });
  try {
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    await settled();
    assertEquals(writes, 1);
    f.welcome();
    await settled();
    assertEquals(writes, 2);
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
    f.navigation.projectHome();
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
    assertEquals(writes, 2);
  } finally {
    f.stop();
  }
});

for (
  const change of [
    "attention",
    "new session",
    "new helper",
    "archive",
    "reconnect",
    "resync",
    "tab reorder",
  ] as const
) {
  Deno.test(`sticky accepted selection survives ${change} and project return before hydration`, async () => {
    const f = fixture("");
    const project = { sidecarId: "local", directory: "/p" };
    const selected = shellEntry("tstv1-other");
    try {
      f.entries("local", [selected, shellEntry("tstv1-selected")]);
      f.navigation.navigate({ sidecarId: "local", sessionID: selected.id });
      // No observeView: acceptance must persist before transcript hydration.
      assert(f.calls.some((c) =>
        c[1] === "layout.location" &&
        (c[2] as { sessionID?: string }).sessionID === selected.id
      ));
      if (change === "archive") selected.archived = true;
      const rows = [selected, shellEntry("tstv1-selected")];
      if (change === "new session") {
        rows.push({
          ...shellEntry("tstv1-new"),
          status: "busy",
          timeUpdated: 99,
        });
      }
      if (change === "new helper") {
        rows.push({
          ...shellEntry("tstv1-helper", "/p", "tstv1-selected"),
          status: "busy",
          timeUpdated: 99,
        });
      }
      if (change === "tab reorder") rows.reverse();
      f.entries("local", rows);
      const urgent = change === "attention"
        ? "tstv1-selected"
        : change === "new session"
        ? "tstv1-new"
        : change === "new helper"
        ? "tstv1-helper"
        : undefined;
      if (urgent) {
        f.resources.receive("local", {
          t: "inbox.snapshot",
          generation: "sticky",
          revision: 0,
          summaryRevision: 0,
          inbox: {
            projects: [],
            tasks: [],
            seen: {},
            finishes: {},
            pathTemplates: [],
            supervision: {
              [urgent]: {
                state: change === "attention" ? "needsYou" : "working",
                terminal: 0,
              },
            },
          },
        });
      }
      if (change === "reconnect") f.welcome();
      if (change === "resync") {
        f.resources.receive("local", { t: "prefs", prefs: DEFAULT_PREFS });
      }
      f.resources.syncTabs(
        project,
        f.resources.tabSnapshot(project),
        f.session.state.selection,
      );
      assertEquals(f.session.state.selection?.sessionID, selected.id);
      assertEquals(f.resources.tabs(project).state.sessionID, selected.id);
      f.navigation.projectHome();
      f.navigation.openProject(project);
      await settled();
      assertEquals(f.session.state.selection?.sessionID, selected.id);
      assertEquals(f.navigation.state.selectionNotice, undefined);
    } finally {
      f.stop();
    }
  });
}

Deno.test("missing remembered sessions use a visible default and persist the accepted replacement", async () => {
  const f = fixture("");
  try {
    f.resources.receive("local", {
      t: "prefs",
      prefs: {
        ...DEFAULT_PREFS,
        shellLayout: {
          ...DEFAULT_PREFS.shellLayout,
          projectLocations: [{
            sidecarId: "local",
            directory: "/p",
            sessionID: "tstv1-missing",
          }],
        },
      },
    });
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(f.session.state.selection?.sessionID, "tstv1-selected");
    assertEquals(
      f.navigation.state.selectionNotice,
      'The remembered session is no longer available. Selected "tstv1-selected".',
    );
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    assertEquals(f.navigation.state.selectionNotice, undefined);
    f.navigation.observeView({
      selected: { sidecarId: "local", sessionID: "tstv1-selected" },
      directory: "/p",
      loading: false,
      settings: false,
      connected: true,
      finish: 0,
    });
    f.navigation.projectHome();
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
  } finally {
    f.stop();
  }
});

Deno.test("explicit session navigation reads the target task without changing memberships during refresh", async () => {
  const f = fixture(), project = { sidecarId: "local", directory: "/p" };
  const tasks = [
    shellTask("parent-task", ["tstv1-selected"]),
    shellTask("child-task", ["tstv1-child"]),
  ];
  const rows = [
    shellEntry("tstv1-selected"),
    shellEntry("tstv1-child", "/p", "tstv1-selected"),
  ];
  try {
    f.entries("local", rows);
    f.resources.receive("local", {
      t: "inbox.snapshot",
      generation: "crumbs",
      revision: 0,
      summaryRevision: 0,
      inbox: { projects: [], tasks, seen: {}, finishes: {}, pathTemplates: [] },
    });
    const before = structuredClone(
      f.resources.inbox("local").state.inbox.tasks,
    );
    for (let n = 0; n < 4; n++) {
      for (
        const [sessionID, taskID] of [["tstv1-child", "parent-task"], [
          "tstv1-selected",
          "parent-task",
        ]]
      ) {
        assert(f.navigation.navigate({ sidecarId: "local", sessionID }));
        // The same reconciliation used by the Shell is the sole tab selection owner.
        f.resources.syncTabs(
          project,
          f.resources.tabSnapshot(project),
          f.session.state.selection,
        );
        const tabs = f.resources.tabs(project);
        assertEquals(tabs.state.selected, { kind: "task", id: taskID });
        assertEquals(tabs.state.sessionID, sessionID);
        assert(
          f.actions.location(f.session.state.selection!, sessionID).includes(
            "parent-task",
          ),
        );
        assertEquals(f.actions.inTask(f.session.state.selection!), true);
        f.entries("local", rows.map((row) => ({ ...row, timeUpdated: n + 2 })));
        assertEquals(f.resources.inbox("local").state.inbox.tasks, before);
      }
    }
    await settled();
    assertEquals(
      f.calls.filter((call) =>
        String(call[1]).startsWith("tasks.") && call[1] !== "tasks.list"
      ),
      [],
    );
  } finally {
    f.stop();
  }
});

Deno.test("explicit attention clicks retain their target and supersede pending project defaults", async () => {
  const f = fixture(), held = Promise.withResolvers<string | undefined>();
  const intents: unknown[] = [];
  f.resources.projectSession = (project, _preferred, attention) => {
    intents.push([project.directory, attention]);
    return attention ? Promise.resolve("tstv1-failed-child") : held.promise;
  };
  try {
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    f.navigation.openAttention({ sidecarId: "local", directory: "/p" });
    await settled();
    held.resolve("tstv1-selected");
    await settled();
    assertEquals(intents, [["/p", undefined], ["/p", true]]);
    assertEquals(f.session.state.selection?.sessionID, "tstv1-failed-child");
  } finally {
    f.stop();
  }
});

Deno.test("project return and cold restore preserve remembered sessions despite attention", async () => {
  for (const cold of [false, true]) {
    const f = fixture(cold ? "#project/local/%2Fp" : "");
    try {
      f.entries("local", [
        shellEntry("tstv1-selected"),
        shellEntry("tstv1-child", "/p", "tstv1-selected"),
        shellEntry("tstv1-urgent-root"),
        shellEntry("tstv1-blocked", "/p", "tstv1-urgent-root"),
      ]);
      f.resources.receive("local", {
        t: "inbox.snapshot",
        generation: "attention",
        revision: 0,
        summaryRevision: 0,
        inbox: {
          projects: [],
          tasks: [],
          seen: {},
          finishes: {},
          pathTemplates: [],
          supervision: {
            "tstv1-selected": { state: "working", terminal: 0 },
            "tstv1-blocked": { state: "needsYou", terminal: 0 },
          },
        },
      });
      f.resources.receive("local", {
        t: "prefs",
        prefs: {
          ...DEFAULT_PREFS,
          shellLayout: {
            ...DEFAULT_PREFS.shellLayout,
            projectLocations: [{
              sidecarId: "local",
              directory: "/p",
              sessionID: "tstv1-child",
            }],
          },
        },
      });
      f.navigation.openProject({ sidecarId: "local", directory: "/p" });
      await settled();
      assertEquals(f.session.state.selection?.sessionID, "tstv1-child");
      f.resources.receive("local", {
        t: "inbox.patch",
        generation: "attention",
        from: 0,
        revision: 2,
        ops: ["tstv1-selected", "tstv1-blocked"].map((sessionID) => ({
          op: "supervision" as const,
          sessionID,
          value: { state: "none" as const, terminal: 0 },
        })),
      });
      f.external("#project/local/%2Fp");
      await settled();
      assertEquals(f.session.state.selection?.sessionID, "tstv1-child");
    } finally {
      f.stop();
    }
  }
});

Deno.test("late default results and failures cannot supersede later navigation or settings", async () => {
  const f = fixture(), held = Promise.withResolvers<string | undefined>();
  try {
    f.resources.projectSession = () => held.promise;
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    held.resolve("tstv1-selected");
    await settled();
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
    const failed = Promise.withResolvers<string | undefined>();
    f.resources.projectSession = () => failed.promise;
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    f.navigation.showSettings();
    failed.reject(new Error("retired default"));
    await settled();
    assertEquals(f.navigation.state.error, "");
  } finally {
    f.stop();
  }
});

Deno.test("default requests capture the clicked project before deferred UI state publishes it", async () => {
  const f = fixture(
    undefined,
    (initial) => ({ ...client.createState(initial), update() {} }),
  );
  const targets: unknown[] = [];
  f.resources.projectSession = (project) => {
    targets.push({ ...project });
    return Promise.resolve("tstv1-away");
  };
  try {
    f.navigation.openProject({ sidecarId: "local", directory: "/away" });
    await settled();
    assertEquals(targets, [{ sidecarId: "local", directory: "/away" }]);
    assertEquals(f.session.state.selection?.sessionID, "tstv1-away");
  } finally {
    f.stop();
  }
});

function fixture(
  hash = "#/local/tstv1-selected",
  factory?: client.StateFactory,
  preferencesReady = true,
) {
  const f = shellFixture({
      selected: "tstv1-selected",
      created: "tstv1-created",
    }),
    drafts = client.createDrafts(),
    messages: string[] = [];
  let consent = true, listener: (() => void) | undefined, at = 0;
  const stack: { state: unknown; hash: string }[] = [{ state: null, hash }];
  const location = { hash, pathname: "/app", search: "?a=1" },
    pushes: string[] = [];
  const hashFrom = (url: unknown) =>
    new URL(String(url), "http://localhost").hash;
  const environment: client.NavigationEnvironment = {
    location,
    history: {
      get state() {
        return stack[at].state;
      },
      replaceState(state, _unused, url) {
        location.hash = url ? hashFrom(url) : location.hash;
        stack[at] = { state, hash: location.hash };
      },
      pushState(state, _unused, url) {
        pushes.push(String(url));
        location.hash = hashFrom(url);
        stack.splice(++at, Infinity, { state, hash: location.hash });
      },
      go(delta = 0) {
        if (!stack[at + delta]) return;
        at += delta;
        location.hash = stack[at].hash;
        listener?.();
      },
    },
    listen(changed) {
      listener = changed;
      return () => {
        listener = undefined;
      };
    },
  };
  f.entries("local", [shellEntry("tstv1-selected"), shellEntry("tstv1-other")]);
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
  const forkNotes = client.createForkNotes();
  const navigation = client.createShellNavigation({
    ...f,
    actions,
    guard,
    drafts,
    forkNotes,
    environment,
    factory,
    presence: () => presence,
    confirm: (message) => {
      messages.push(message);
      return consent;
    },
  });
  if (preferencesReady) {
    f.resources.receive("local", { t: "prefs", prefs: DEFAULT_PREFS });
  }
  navigation.start();
  f.calls.length = 0;
  return {
    ...f,
    drafts,
    forkNotes,
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
      stack.splice(++at, Infinity, { state: null, hash: next });
      listener?.();
    },
    welcome(server = "local", reconnect = true) {
      const item = f.servers.state.list.find((item) => item.id === server)!;
      if (reconnect) item.connectionVersion = (item.connectionVersion ?? 0) + 1;
      f.resources.receive(server, {
        t: "welcome",
        protocol: 17,
        requests: fixtureRequests(),
        messages: fixtureMessagePolicy,
        sidecar: {
          version: "test",
          build: "test",
          instance: "test",
          harness: { kind: "test", version: "1", url: "http://127.0.0.1" },
        },
      });
    },
    stop() {
      navigation.stop();
      f.resources.stop();
      assertEquals(listener, undefined);
    },
  };
}

Deno.test("failed project default retries on welcome without a new navigation intent", async () => {
  const f = fixture(), held = Promise.withResolvers<string | undefined>();
  let reads = 0;
  f.resources.projectSession = () => {
    reads++;
    return reads === 1 ? held.promise : Promise.resolve("tstv1-other");
  };
  try {
    f.external("#project/local/%2Fp");
    f.resources.receive("local", { t: "prefs", prefs: DEFAULT_PREFS });
    assertEquals(reads, 1, "a pending attempt is joined");
    held.reject(new Error("disconnected default"));
    await settled();
    f.welcome();
    await settled();
    assertEquals(reads, 2);
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
    assertEquals(f.navigation.state.error, "");
  } finally {
    f.stop();
  }
});
Deno.test("project defaults replace the pending entry even on traversal, preserving Forward", async () => {
  const f = fixture();
  try {
    const project = { sidecarId: "local", directory: "/other" };
    const { promise, resolve } = Promise.withResolvers<string>();
    f.resources.projectSession = () => promise;
    f.navigation.openProject(project);
    assertEquals(f.location.hash, "#project/local/%2Fother");
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    f.navigation.showSettings();
    assert(f.navigation.back());
    assertEquals(f.navigation.state.settings, false);
    resolve("tstv1-selected");
    await settled();
    assertEquals(f.location.hash, "#/local/tstv1-selected");
    assertEquals(f.navigation.state.history.at, 1);
    assertEquals(f.pushes.length, 2);
    assert(f.navigation.forward());
    assertEquals(f.location.hash, "#/local/tstv1-other");
  } finally {
    f.stop();
  }
});

Deno.test("explicit Home remains a project page on traversal without resolving a default", () => {
  const f = fixture();
  try {
    const before = f.calls.filter((c) => c[1] === "navigation.default").length;
    assert(f.navigation.projectHome());
    f.navigation.preview({ sidecarId: "local", sessionID: "tstv1-other" });
    assert(f.navigation.back());
    assertEquals(f.session.state.selection, undefined);
    assertEquals(f.location.hash, "#project/local/%2Fp");
    assertEquals(
      f.calls.filter((c) => c[1] === "navigation.default").length,
      before,
    );
    assert(f.navigation.forward());
    assertEquals(f.location.hash, "#/local/tstv1-other");
  } finally {
    f.stop();
  }
});

Deno.test("history labels prefer the index and only fall back to recorded labels when unavailable", () => {
  const hash = "#/local/tstv1-other";
  const recorded = { hash, title: "Old title", project: "Old project" };
  const lookup = () => ({ title: "Current title", project: "Current project" });
  const unavailable = () => undefined;
  assertEquals(
    client.historyTarget({ at: 1, back: recorded }, "back", lookup),
    {
      enabled: true,
      label: "Back to Current title in Current project",
      state: "live",
    },
  );
  assertEquals(
    client.historyTarget(
      { at: 0, forward: recorded },
      "forward",
      () => ({ ...lookup(), deleted: true }),
    ),
    {
      enabled: true,
      label: "Forward to Current title in Current project (deleted)",
      state: "deleted",
    },
  );
  assertEquals(
    client.historyTarget({ at: 1, back: recorded }, "back", unavailable),
    {
      enabled: true,
      label: "Back to Old title in Old project (unavailable)",
      state: "unavailable",
    },
  );
  assertEquals(
    client.historyTarget({ at: 1, back: { hash } }, "back", unavailable).label,
    "Back to an unavailable session",
  );
  assertEquals(
    client.historyTarget(
      { at: 1, back: { hash: "#project/local/%2Fp", page: true } },
      "back",
      unavailable,
    ).label,
    "Back to the p project page",
  );
  assertEquals(
    client.historyTarget({ at: 1, back: { hash: "" } }, "back", unavailable)
      .label,
    "Back to the start page",
  );
  assertEquals(
    client.historyTarget({ at: 1, back: "unrecorded" }, "back", unavailable)
      .label,
    "Back to the previous page",
  );
  assertEquals(client.historyTarget({ at: 0 }, "forward", unavailable), {
    enabled: false,
    label: "No later session in this tab",
    state: "unknown",
  });
});

Deno.test("completed empty project defaults are not replayed by view observations or welcomes", async () => {
  const f = fixture();
  let reads = 0;
  f.resources.projectSession = () => {
    reads++;
    return Promise.resolve(undefined);
  };
  try {
    f.external("#project/local/%2Fp");
    await settled();
    for (let i = 0; i < 3; i++) {
      f.navigation.observeView({
        directory: "/p",
        loading: false,
        settings: false,
        connected: true,
        finish: 0,
      });
      await settled();
    }
    f.welcome();
    await settled();
    assertEquals(reads, 1, "successful empty lookup consumes this intent");
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(reads, 2, "an explicit click starts a new intent");
  } finally {
    f.stop();
  }
});

Deno.test("failed project defaults wait for their own connection advance, not ordinary view or unrelated welcome", async () => {
  const f = fixture();
  let reads = 0;
  f.resources.projectSession = () => {
    reads++;
    return reads === 1
      ? Promise.reject(new Error("held generation failed"))
      : Promise.resolve(undefined);
  };
  try {
    f.external("#project/local/%2Fp");
    await settled();
    assert(f.navigation.state.error);
    f.navigation.observeView({
      directory: "/p",
      loading: false,
      settings: false,
      connected: true,
      finish: 0,
    });
    await settled();
    assertEquals(
      reads,
      1,
      "a failed attempt is not a view-triggered retry loop",
    );
    f.welcome("remote");
    await settled();
    assertEquals(reads, 1, "another server cannot retry this default");
    f.welcome("local", false);
    await settled();
    assertEquals(reads, 1, "duplicate welcome is not another connection");
    f.welcome();
    await settled();
    assertEquals(reads, 2);
  } finally {
    f.stop();
  }
});

Deno.test("successful empty project default recovery clears its old lookup failure", async () => {
  const f = fixture();
  let reads = 0;
  f.resources.projectSession = () => {
    reads++;
    return reads === 1
      ? Promise.reject(new Error("default lookup failed"))
      : Promise.resolve(undefined);
  };
  try {
    f.external("#project/local/%2Fp");
    await settled();
    assert(f.navigation.state.error);
    f.welcome();
    await settled();
    assertEquals(reads, 2);
    assertEquals<unknown>(
      f.navigation.state.error,
      "",
      "empty success is recovery too",
    );
    assertEquals(f.session.state.selection, undefined);
    assertEquals(f.location.hash, "#project/local/%2Fp");
  } finally {
    f.stop();
  }
});

Deno.test("connection advance during a pending default is joined once if that lookup then fails", async () => {
  const f = fixture(), held = Promise.withResolvers<string | undefined>();
  let reads = 0;
  f.resources.projectSession = () => {
    reads++;
    return reads === 1 ? held.promise : Promise.resolve("tstv1-other");
  };
  try {
    f.external("#project/local/%2Fp");
    f.welcome();
    assertEquals(reads, 1, "pending lookup remains joined");
    held.reject(new Error("old pending lookup failed"));
    await settled();
    assertEquals(reads, 2, "failure observes the already advanced connection");
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
    assertEquals(f.navigation.state.error, "");
    f.welcome();
    await settled();
    assertEquals(reads, 2);
  } finally {
    f.stop();
  }
});

for (const superseded of [false, true]) {
  for (const deferred of [false, true]) {
    Deno.test(`same-project default intent waits for preferences${superseded ? " and respects a newer route" : ""}${deferred ? " with deferred view state" : ""}`, async () => {
      const f = fixture(
        undefined,
        deferred
          ? (initial) => ({ ...client.createState(initial), update() {} })
          : undefined,
        false,
      );
      const targets: unknown[] = [];
      f.resources.projectSession = (target) => {
        targets.push({ ...target });
        return Promise.resolve("tstv1-other");
      };
      try {
        f.navigation.openProject({ sidecarId: "local", directory: "/p" });
        assertEquals(targets, []);
        if (superseded) {
          f.navigation.navigate({
            sidecarId: "local",
            sessionID: "tstv1-selected",
          });
        }
        f.resources.receive("local", { t: "prefs", prefs: DEFAULT_PREFS });
        await settled();
        assertEquals(
          targets,
          superseded ? [] : [{ sidecarId: "local", directory: "/p" }],
        );
        assertEquals(
          f.session.state.selection?.sessionID,
          superseded ? "tstv1-selected" : "tstv1-other",
        );
      } finally {
        f.stop();
      }
    });
  }
}

Deno.test("a resolved project intent cannot replay a declined navigation guard on later frames", async () => {
  const f = fixture();
  let reads = 0;
  f.resources.projectSession = () => {
    reads++;
    return Promise.resolve("tstv1-other");
  };
  try {
    f.guard.mark("permissions", true);
    f.consent(false);
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(reads, 1);
    assertEquals(f.messages.length, 1);
    f.resources.receive("local", { t: "prefs", prefs: DEFAULT_PREFS });
    await settled();
    assertEquals(reads, 1, "a completed lookup consumes the captured intent");
    assertEquals(f.messages.length, 1, "declining is not an automatic retry");
    assertEquals(f.session.state.selection?.sessionID, "tstv1-selected");
    assertEquals(f.guard.dirty("permissions"), true);
    f.consent(true);
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(reads, 2, "a later explicit click is a new intent");
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
  } finally {
    f.stop();
  }
});

Deno.test("removing a direct-route server detaches even while its project metadata is unknown", () => {
  const f = fixture("#/remote/tstv1-loading");
  try {
    assertEquals(f.navigation.state.project, undefined);
    assertEquals(f.navigation.removeServer("remote"), true);
    assertEquals(
      f.session.state.selection,
      undefined,
      "Removed server is still selected",
    );
    assertEquals(f.location.hash, "");
    assertEquals(
      f.navigation.state.history.at,
      0,
      "server removal replaces the release route",
    );
    assert(
      f.calls.findIndex((call) => call[0] === "open") <
        f.calls.findIndex((call) => call[0] === "remove"),
    );
  } finally {
    f.stop();
  }
});

Deno.test("nested routes and immediate remembered leaf navigation keep exact persisted location directories", async () => {
  const f = fixture(), saved: unknown[] = [];
  const pending = Promise.withResolvers<void>();
  f.resources.rememberLocation = (location) => {
    saved.push(location);
    return pending.promise;
  };
  f.entries("local", [shellEntry("tstv1-selected", "/tree/src")]);
  f.resources.receive("local", {
    t: "inbox.snapshot",
    generation: "g",
    revision: 0,
    summaryRevision: 0,
    inbox: {
      projects: [],
      tasks: [],
      seen: {},
      finishes: {},
      pathTemplates: [],
      summaries: {
        "/tree": {
          directory: "/tree",
          status: "none",
          sessionCount: 1,
          unseenCount: 0,
          lastActivity: 2,
          authority: "current",
          scopes: ["/tree", "/tree/src"],
          topology: {
            repoID: "p",
            canonicalRoot: "/repo",
            leafDirectory: "/tree",
            parentDirectory: "/repo",
          },
        },
      },
    },
  });
  try {
    f.navigation.observeView({
      selected: { sidecarId: "local", sessionID: "tstv1-selected" },
      directory: "/tree/src",
      loading: false,
      settings: false,
      connected: true,
      finish: 0,
    });
    assertEquals(f.navigation.state.project, {
      sidecarId: "local",
      directory: "/tree",
    });
    assertEquals(saved, [{
      sidecarId: "local",
      directory: "/tree/src",
      sessionID: "tstv1-selected",
    }]);
    f.navigation.openProject({ sidecarId: "local", directory: "/other" });
    f.navigation.openProject({ sidecarId: "local", directory: "/tree" });
    await settled();
    assertEquals(f.session.state.selection?.sessionID, "tstv1-selected");
    assertEquals(f.navigation.state.project?.directory, "/tree");
  } finally {
    pending.resolve();
    f.stop();
  }
});

Deno.test("a late catalog establishes the selected project while its transcript is still loading", () => {
  const f = fixture("#/remote/tstv1-loading");
  try {
    const view = {
      selected: { sidecarId: "remote", sessionID: "tstv1-loading" },
      directory: undefined,
      loading: true,
      settings: false,
      connected: true,
      finish: 0,
    };
    f.session.state.info = undefined;
    f.navigation.observeView(view);
    assertEquals(f.navigation.state.project, undefined);
    f.entries("remote", [shellEntry("tstv1-loading", "/late")]);
    f.navigation.observeView(view);
    assertEquals(f.navigation.state.project, {
      sidecarId: "remote",
      directory: "/late",
    });
    assertEquals(
      f.resources.projectEntries(f.navigation.state.project!).length,
      1,
    );
    assertEquals(
      f.calls,
      [["local", "layout.location", {
        sidecarId: "remote",
        directory: "/late",
        sessionID: "tstv1-loading",
      }]],
      "Metadata readiness persists the accepted destination, never marks content seen or requests bodies",
    );
    assertEquals(f.location.hash, "#/remote/tstv1-loading");
  } finally {
    f.stop();
  }
});

Deno.test("legacy session links show the compatibility notice without requesting native session resources", () => {
  const f = fixture("#/local/ses_legacy");
  try {
    assertEquals(
      f.navigation.state.error && f.navigation.state.error.failure?.reason,
      "This session link is from an older version. Open Sessions to choose a session.",
    );
    assertEquals(f.session.state.selection, undefined);
    assertEquals(
      f.calls.some((call) =>
        typeof call[1] === "string" &&
        /^(session\.|models\.|permission\.|question\.|usage\.)/.test(call[1])
      ),
      false,
    );
  } finally {
    f.stop();
  }
});

Deno.test("fork navigation preserves original drafts, notes successful forks and fences later navigation", async () => {
  const f = fixture();
  try {
    f.drafts.writer("local/tstv1-selected")({
      ...client.emptyDraft(),
      input: "Keep me",
    });
    f.reply((_id, method) =>
      Promise.resolve(
        method === "session.fork" ? shellInfo("tstv1-fork") : null,
      )
    );
    await f.navigation.fork({
      sidecarId: "local",
      sessionID: "tstv1-selected",
      title: "Source",
    }, "last");
    assertEquals(f.session.state.selection?.sessionID, "tstv1-fork");
    assertEquals(f.forkNotes.get("local/tstv1-fork"), { from: "Source" });
    assertEquals(f.drafts.get("local/tstv1-fork").input, "");
    assertEquals(f.drafts.get("local/tstv1-selected").input, "Keep me");
    assertEquals(f.messages, []);
    const held = Promise.withResolvers<unknown>();
    f.reply((_id, method) =>
      method === "session.fork" ? held.promise : Promise.resolve(null)
    );
    const pending = f.navigation.fork({
      sidecarId: "local",
      sessionID: "tstv1-selected",
      title: "Source",
    });
    await settled();
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    held.resolve(shellInfo("tstv1-late-fork"));
    await pending;
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
    assertEquals(f.forkNotes.get("local/tstv1-late-fork"), { from: "Source" });
  } finally {
    f.stop();
  }
});
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
  f.external("#/unknown/tstv1-session");
  assertEquals(
    f.navigation.state.error && f.navigation.state.error.failure?.reason,
    "The URL refers to an unknown server. Add it in Settings.",
  );
  assertEquals(f.navigation.state.project, undefined);
  assertEquals(f.session.state.selection, undefined);
  f.navigation.fail(new Error("plain failure"));
  assertEquals(
    f.navigation.state.error && f.navigation.state.error.failure?.reason,
    "OTK has no further details",
  );
  f.navigation.clearError();
  assertEquals(f.navigation.state.error, "");
  assert(changes > 0);
  release();
  f.stop();
});
Deno.test("project-only routes defer visits until connected and retain view-only bookkeeping after reload", async () => {
  const f = fixture();
  try {
    f.servers.state.list[0].status = "reconnecting";
    f.external("#project/local/%2Fdiscovered");
    await settled();
    assertEquals(f.calls.filter((call) => call[1] === "projects.visit"), []);
    f.servers.state.list[0].status = "connected";
    const view = {
      selected: undefined,
      directory: "/discovered",
      connected: true,
      loading: false,
      settings: false,
      finish: 0,
    };
    f.navigation.observeView(view);
    f.navigation.observeView(view);
    await settled();
    assertEquals(f.calls.filter((call) => call[1] === "projects.visit"), [[
      "local",
      "projects.visit",
      { directory: "/discovered" },
    ]]);
    assertEquals(f.navigation.state.error, "");
  } finally {
    f.stop();
  }
});
Deno.test("shell navigation confirms and clears dirty owners only on selection change", () => {
  const f = fixture();
  f.guard.mark("permissions", true);
  f.consent(false);
  assertEquals(
    f.navigation.navigate({
      sidecarId: "local",
      sessionID: "tstv1-selected",
      rootID: "tstv1-hint",
    }),
    true,
  );
  assertEquals(f.messages, []);
  assertEquals(f.guard.dirty("permissions"), true);
  assertEquals(
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" }),
    false,
  );
  assertEquals(f.guard.dirty("permissions"), true);
  f.consent(true);
  assertEquals(
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" }),
    true,
  );
  assertEquals(f.guard.dirty("permissions"), false);
  f.stop();
});
Deno.test("child navigation reports a declined guard instead of settling silently", () => {
  const f = fixture();
  f.entries("local", [shellEntry("tstv1-selected"), shellEntry("tstv1-other")]);
  assert(
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-selected" }),
  );
  f.guard.mark("permissions", true);
  f.consent(false);
  assertEquals(f.navigation.openChild("tstv1-other"), false);
  assertEquals(f.location.hash, "#/local/tstv1-selected");
  f.consent(true);
  assertEquals(f.navigation.openChild("tstv1-other"), true);
  assertEquals(f.location.hash, "#/local/tstv1-other");
  f.stop();
});
Deno.test("shell navigation normalizes roots and same-session reselection visits without another push", async () => {
  const f = fixture();
  f.entries("local", [
    shellEntry("tstv1-root"),
    shellEntry("tstv1-middle", "/p", "tstv1-root"),
    shellEntry("tstv1-leaf", "/p", "tstv1-middle"),
  ]);
  assert(
    f.navigation.navigate({
      sidecarId: "local",
      sessionID: "tstv1-leaf",
      rootID: "tstv1-middle",
    }),
  );
  assertEquals(f.location.hash, "#/local/tstv1-root/tstv1-leaf");
  const count = f.pushes.length;
  assert(
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-leaf" }),
  );
  await settled();
  assertEquals(f.pushes.length, count);
  assertEquals(f.calls.filter((c) => c[1] === "sessions.seen"), [[
    "local",
    "sessions.seen",
    { sessionID: "tstv1-leaf", terminal: 0 },
  ]]);
  f.navigation.openChild("tstv1-unknown");
  assertEquals(f.location.hash, "#/local/tstv1-root/tstv1-unknown");
  f.stop();
});
Deno.test("shell navigation opens existing project roots or project-only hashes and home", async () => {
  const f = fixture();
  f.navigation.showSettings();
  f.navigation.openProject({ sidecarId: "local", directory: "/empty" });
  assertEquals(f.location.hash, "#project/local/%2Fempty");
  assertEquals(f.navigation.state.settings, false);
  f.entries("local", [shellEntry("tstv1-selected"), shellEntry("tstv1-other")]);
  f.navigation.openProject({ sidecarId: "local", directory: "/p" });
  await settled();
  assertEquals(f.location.hash, "#/local/tstv1-selected");
  f.navigation.showSettings();
  const count = f.pushes.length;
  f.navigation.openProject({ sidecarId: "local", directory: "/p" });
  assertEquals(f.pushes.length, count);
  assertEquals(f.navigation.state.settings, false);
  assertEquals(f.navigation.projectHome(), true);
  assertEquals(f.location.hash, "#project/local/%2Fp");
  await settled();
  assertEquals(
    f.session.state.selection,
    undefined,
    "Home is an explicit project page, not another default intent",
  );
  f.stop();
});
Deno.test("project memory restores exact helpers through guarded navigation and rejects stale project identities", async () => {
  const f = fixture("");
  try {
    f.entries("local", [
      shellEntry("tstv1-selected"),
      shellEntry("tstv1-helper", "/p", "tstv1-selected"),
      shellEntry("tstv1-away", "/away"),
    ]);
    f.resources.receive("local", {
      t: "prefs",
      prefs: {
        ...DEFAULT_PREFS,
        shellLayout: {
          ...DEFAULT_PREFS.shellLayout,
          projectLocations: [{
            sidecarId: "local",
            directory: "/p",
            sessionID: "tstv1-helper",
          }, {
            sidecarId: "local",
            directory: "/away",
            sessionID: "tstv1-selected",
          }],
        },
      },
    });
    f.navigation.openProject({ sidecarId: "local", directory: "/away" });
    await settled();
    assertEquals(f.location.hash, "#/local/tstv1-away");
    f.guard.mark("permissions", true);
    f.consent(false);
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(f.location.hash, "#/local/tstv1-away");
    f.consent(true);
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(f.location.hash, "#/local/tstv1-selected/tstv1-helper");
  } finally {
    f.stop();
  }
});
Deno.test("pending location writes bridge fast switches without accepting older preference broadcasts", async () => {
  const f = fixture(), held = Promise.withResolvers<unknown>();
  try {
    f.entries("local", [
      shellEntry("tstv1-selected"),
      shellEntry("tstv1-other"),
      shellEntry("tstv1-away", "/away"),
    ]);
    f.reply((_id, method) =>
      method === "layout.location" ? held.promise : Promise.resolve(null)
    );
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    f.navigation.observeView({
      selected: f.session.state.selection,
      directory: "/p",
      loading: false,
      settings: false,
      connected: true,
      finish: 0,
    });
    f.resources.receive("local", { t: "prefs", prefs: DEFAULT_PREFS });
    f.navigation.openProject({ sidecarId: "local", directory: "/away" });
    f.navigation.openProject({ sidecarId: "local", directory: "/p" });
    await settled();
    assertEquals(f.location.hash, "#/local/tstv1-other");
    held.resolve(null);
    await settled();
  } finally {
    f.stop();
  }
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
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    if (rejected) held.reject(new Error("old failure"));
    else held.resolve(shellInfo("tstv1-created"));
    await creating;
    assertEquals(f.session.state.selection?.sessionID, "tstv1-other");
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
  held.resolve(shellInfo("tstv1-created", "/remote"));
  await creating;
  assertEquals(f.calls.slice(0, 2), [["remote", "session.create", {
    directory: "/remote",
  }], ["remote", "tasks.addSession", {
    id: "task",
    sessionID: "tstv1-created",
  }]]);
  assertEquals(f.location.hash, "#/remote/tstv1-created");
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
  held.resolve(shellInfo("tstv1-selected", "/resolved"));
  await creating;
  assertEquals(f.calls, [["local", "session.get", {
    sessionID: "tstv1-selected",
  }]]);
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
  const f = fixture(),
    selected = { sidecarId: "local", sessionID: "tstv1-selected" };
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
  assertEquals(f.calls, [
    ["local", "projects.visit", { directory: "/p" }],
    [
      "local",
      "sessions.seen",
      { sessionID: "tstv1-selected", terminal: 1 },
    ],
  ]);
  f.resources.receive("local", {
    t: "prefs",
    prefs: {
      ...DEFAULT_PREFS,
      shellLayout: {
        ...DEFAULT_PREFS.shellLayout,
        projectLocations: [{ ...selected, directory: "/p" }],
      },
    },
  });
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
    sessionID: "tstv1-selected",
    terminal: 2,
  }]]);
  f.calls.length = 0;
  f.navigation.observeView({ ...view, selected: undefined });
  f.navigation.observeView(view);
  await settled();
  assertEquals(f.calls.length, 2);
  f.stop();
});
for (const finishOrder of ["before open", "after open"] as const) {
  Deno.test(`seen acknowledges each displayed terminal once: finish ${finishOrder}`, async () => {
    const f = fixture();
    const view = {
      selected: { sidecarId: "local", sessionID: "tstv1-selected" },
      directory: "/p",
      loading: false,
      settings: false,
      connected: true,
      finish: finishOrder === "before open" ? 41 : 0,
    };
    try {
      f.navigation.observeView(view);
      await settled();
      for (const finish of [41, 41, 0, 41]) {
        f.navigation.observeView({ ...view, finish });
      }
      await settled();
      assertEquals(
        f.calls.filter((call) => call[1] === "sessions.seen"),
        (finishOrder === "before open" ? [41] : [0, 41]).map((terminal) => [
          "local",
          "sessions.seen",
          { sessionID: view.selected.sessionID, terminal },
        ]),
      );
    } finally {
      f.stop();
    }
  });
}
Deno.test("shell navigation preview and pin share guarded target transitions and avoid duplicate helper tasks", async () => {
  const f = fixture();
  f.entries("local", [
    shellEntry("tstv1-selected"),
    shellEntry("tstv1-helper", "/p", "tstv1-selected"),
  ]);
  f.resources.inbox("local").state.inbox.tasks = [
    shellTask("existing", ["tstv1-selected"]),
  ];
  assertEquals(
    f.navigation.preview({ sidecarId: "local", sessionID: "tstv1-helper" }),
    true,
  );
  assertEquals(
    await f.navigation.pin({ sidecarId: "local", sessionID: "tstv1-helper" }),
    true,
  );
  assertEquals(f.calls.some((c) => c[1] === "tasks.create"), false);
  assertEquals(
    await f.navigation.pin({ sidecarId: "local", sessionID: "tstv1-missing" }),
    false,
  );
  await settled();
  f.stop();
});

Deno.test("close session removes only captured membership, clears its view and retains backend metadata", async () => {
  const f = fixture();
  try {
    const inbox = f.resources.inbox("local").state.inbox;
    inbox.tasks = [shellTask("task", ["tstv1-selected", "tstv1-other"])];
    const tabs = f.resources.tabs({ sidecarId: "local", directory: "/p" });
    tabs.preview("tstv1-selected");
    await f.navigation.close({
      sidecarId: "local",
      sessionID: "tstv1-selected",
    });
    assertEquals(f.calls.filter((c) => String(c[1]).startsWith("tasks.")), [[
      "local",
      "tasks.removeSession",
      { id: "task", sessionID: "tstv1-selected" },
    ]]);
    assertEquals(f.location.hash, "#/local/tstv1-other");
    assertEquals(tabs.state.sessionID, undefined);
    assertEquals(
      f.navigation.state.history.at,
      0,
      "close replaces the released entry",
    );
    assert(f.resources.entry("local", "tstv1-selected"));
    assertEquals(f.calls.some((c) => c[1] === "session.delete"), false);
  } finally {
    f.stop();
  }
});

Deno.test("deleting the visible last session replaces it with a deliberate project page", async () => {
  const f = fixture();
  try {
    assert(
      await f.navigation.remove({
        sidecarId: "local",
        sessionID: "tstv1-selected",
      }),
    );
    assertEquals(f.location.hash, "#project/local/%2Fp");
    assertEquals(f.navigation.state.history.at, 0);
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    assertEquals(f.navigation.state.history.back, {
      hash: "#project/local/%2Fp",
      page: true,
    });
  } finally {
    f.stop();
  }
});

Deno.test("close keeps an unsent draft without asking, while delete cancel preserves session and draft", async () => {
  const f = fixture();
  try {
    const draft = { ...client.emptyDraft(), input: "Keep this draft" };
    f.drafts.writer("local/tstv1-selected")(draft);
    assertEquals(await f.navigation.close(), true);
    assertEquals(f.messages, []);
    assertEquals(f.drafts.get("local/tstv1-selected"), draft);
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-selected" });
    f.calls.length = 0;
    f.consent(false);
    assertEquals(
      await f.navigation.remove({
        sidecarId: "local",
        sessionID: "tstv1-selected",
      }),
      false,
    );
    assertEquals(f.messages.length, 1);
    assertEquals(f.calls, []);
    assert(f.resources.entry("local", "tstv1-selected"));
    assertEquals(f.drafts.get("local/tstv1-selected"), draft);
    assertEquals(f.location.hash, "#/local/tstv1-selected");
  } finally {
    f.stop();
  }
});

Deno.test("delete confirmation drops only successfully deleted family drafts and failure preserves them", async () => {
  const f = fixture();
  try {
    f.entries("local", [
      shellEntry("tstv1-selected"),
      shellEntry("tstv1-helper", "/p", "tstv1-selected"),
      shellEntry("tstv1-other"),
    ]);
    const draft = {
      ...client.emptyDraft(),
      input: "Unsent",
      editor: { text: "Unsubmitted edit" },
    };
    f.drafts.writer("local/tstv1-selected")(draft);
    f.drafts.writer("local/tstv1-helper")(draft);
    f.drafts.writer("local/tstv1-other")(draft);
    f.reply((_id, method) =>
      method === "session.delete"
        ? Promise.reject(new Error("Delete failed"))
        : Promise.resolve(null)
    );
    let error: unknown;
    try {
      await f.navigation.remove({
        sidecarId: "local",
        sessionID: "tstv1-selected",
      });
    } catch (cause) {
      error = cause;
    }
    assertEquals((error as Error).message, "Delete failed");
    assertEquals(f.drafts.get("local/tstv1-selected"), draft);
    assertEquals(f.drafts.get("local/tstv1-helper"), draft);
    assertEquals(f.location.hash, "#/local/tstv1-selected");
    f.reply((_id, method) => {
      if (method === "session.delete") {
        f.entries("local", [shellEntry("tstv1-other")]);
      }
      return Promise.resolve(null);
    });
    assertEquals(
      await f.navigation.remove({
        sidecarId: "local",
        sessionID: "tstv1-selected",
      }),
      true,
    );
    assertEquals(f.resources.entry("local", "tstv1-selected"), undefined);
    assertEquals(f.resources.entry("local", "tstv1-helper"), undefined);
    assertEquals(f.drafts.get("local/tstv1-selected"), client.emptyDraft());
    assertEquals(f.drafts.get("local/tstv1-helper"), client.emptyDraft());
    assertEquals(f.drafts.get("local/tstv1-other"), draft);
    assertEquals(f.location.hash, "#project/local/%2Fp");
    assertEquals(f.messages.length, 2);
  } finally {
    f.stop();
  }
});

Deno.test("delete without a draft asks no extra question and cannot steal a later navigation", async () => {
  const f = fixture();
  try {
    const held = Promise.withResolvers<null>();
    f.reply((_id, method) =>
      method === "session.delete" ? held.promise : Promise.resolve(null)
    );
    const removing = f.navigation.remove({
      sidecarId: "local",
      sessionID: "tstv1-selected",
    });
    await settled();
    assertEquals(f.messages, []);
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    held.resolve(null);
    await removing;
    assertEquals(f.location.hash, "#/local/tstv1-other");
  } finally {
    f.stop();
  }
});

Deno.test("close helper returns to its immediate parent without removing inherited membership", async () => {
  const f = fixture("#/local/tstv1-selected/tstv1-helper");
  try {
    f.entries("local", [
      shellEntry("tstv1-selected"),
      shellEntry("tstv1-helper", "/p", "tstv1-selected"),
    ]);
    f.resources.inbox("local").state.inbox.tasks = [
      shellTask("task", ["tstv1-selected"]),
    ];
    const tabs = f.resources.tabs({ sidecarId: "local", directory: "/p" });
    tabs.preview("tstv1-helper");
    await f.navigation.close({ sidecarId: "local", sessionID: "tstv1-helper" });
    assertEquals(f.location.hash, "#/local/tstv1-selected");
    assertEquals(f.calls.some((c) => c[1] === "tasks.removeSession"), false);
    assertEquals(f.resources.inbox("local").state.inbox.tasks[0].sessions, [
      "tstv1-selected",
    ]);
    assertEquals(
      client.taskBreadcrumbs(
        shellTask("task", ["tstv1-selected"]),
        f.resources.projectEntries({ sidecarId: "local", directory: "/p" }),
      ).map((c) => c.id),
      ["tstv1-selected"],
    );
    tabs.preview("tstv1-helper");
    assertEquals(tabs.state.closed, []);
  } finally {
    f.stop();
  }
});

for (const status of ["working", "blocked", "finished"] as const) {
  Deno.test(`close ${status} session confirms and retains its mandatory phantom until idle and seen`, async () => {
    const f = fixture();
    try {
      const entry = shellEntry("tstv1-selected");
      if (status === "working") entry.status = "busy";
      if (status === "blocked") entry.attention.permissions = 1;
      f.entries("local", [entry]);
      const inbox = f.resources.inbox("local").state.inbox;
      if (status === "finished") inbox.finishes["tstv1-selected"] = 10;
      inbox.supervision = {
        [entry.id]: {
          state: status === "blocked"
            ? "needsYou"
            : status === "finished"
            ? "finishedUnseen"
            : "working",
          terminal: status === "finished" ? 10 : 0,
        },
      };
      f.resources.receive("local", {
        t: "inbox.snapshot",
        generation: "fixture",
        revision: 0,
        inbox,
      });
      const tabs = f.resources.tabs({ sidecarId: "local", directory: "/p" });
      tabs.preview("tstv1-selected");
      f.consent(false);
      assertEquals(await f.navigation.close(), false);
      assertEquals(f.location.hash, "#/local/tstv1-selected");
      assertEquals(tabs.state.sessionID, "tstv1-selected");
      assert(
        f.messages.at(-1)?.includes(
          "task will stay visible while it has known activity or an unseen finish",
        ),
      );
      f.consent(true);
      assertEquals(await f.navigation.close(), true);
      assertEquals(f.location.hash, "#project/local/%2Fp");
      assertEquals(
        tabs.tabs().map((tab) => [tab.id, tab.status, tab.preview]),
        [["tstv1-selected", status, false]],
      );
      entry.status = "idle";
      entry.attention.permissions = 0;
      f.entries("local", [entry]);
      inbox.seen["tstv1-selected"] = 11;
      inbox.supervision = { [entry.id]: { state: "none", terminal: 10 } };
      f.resources.receive("local", {
        t: "inbox.snapshot",
        generation: "fixture",
        revision: 0,
        inbox,
      });
      tabs.update(
        f.resources.tabSnapshot({ sidecarId: "local", directory: "/p" }),
      );
      assertEquals(tabs.tabs(), []);
    } finally {
      f.stop();
    }
  });
}

Deno.test("repeated view observations preserve canonical project identity without republishing the same selection", () => {
  const f = fixture();
  const view = {
    selected: { sidecarId: "local", sessionID: "tstv1-selected" },
    directory: "/p",
    loading: false,
    settings: false,
    connected: true,
    finish: 0,
  };
  f.navigation.observeView(view); // The first view also labels the history entry.
  let writes = 0;
  const original = f.navigation.state.project;
  const release = f.navigation.subscribe(() => {
    writes++;
  });
  try {
    assert(original);
    for (let i = 0; i < 10; i++) {
      f.navigation.observeView(view);
    }
    assertStrictEquals(f.navigation.state.project, original);
    assertEquals(writes, 0);
  } finally {
    release();
    f.stop();
  }
});

Deno.test("navigation observes project selection without replacing the canonical transcript scope hint", () => {
  const f = fixture();
  let hints = 0;
  f.resources.scope = () => {
    hints++;
  };
  try {
    f.navigation.observeView({
      selected: { sidecarId: "local", sessionID: "tstv1-selected" },
      directory: "/p",
      loading: false,
      settings: false,
      connected: true,
      finish: 0,
    });
    assertEquals(hints, 0);
  } finally {
    f.stop();
  }
});

Deno.test("close cancellation, failed membership and a later route preserve the current view and dirty input", async () => {
  const f = fixture();
  try {
    f.guard.mark("permissions", true);
    f.consent(false);
    assertEquals(await f.navigation.close(), false);
    assertEquals(f.calls, []);
    assertEquals(f.guard.dirty("permissions"), true);
    f.consent(true);
    f.resources.inbox("local").state.inbox.tasks = [
      shellTask("task", ["tstv1-selected"]),
    ];
    f.reply(() => Promise.reject(new Error("membership failed")));
    let failure: unknown;
    try {
      await f.navigation.close();
    } catch (error) {
      failure = error;
    }
    assertEquals((failure as Error).message, "membership failed");
    assertEquals(f.location.hash, "#/local/tstv1-selected");
    const held = Promise.withResolvers<unknown>();
    f.reply(() => held.promise);
    const closing = f.navigation.close();
    await settled();
    f.navigation.navigate({ sidecarId: "local", sessionID: "tstv1-other" });
    held.resolve(null);
    await closing;
    assertEquals(f.location.hash, "#/local/tstv1-other");
  } finally {
    f.stop();
  }
});
