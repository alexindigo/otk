// SPDX-License-Identifier: LGPL-3.0-only
// Shared hierarchy consumers retain native family identity across checkouts.
import { assert, assertEquals } from "@std/assert";
import * as client from "@otk/client";
import { DEFAULT_PREFS } from "@otk/protocol";
import { shellEntry, shellFixture } from "./shell-fixture.ts";

Deno.test("tabs and crumbs borrow the same PH1-local task projection for nested scopes", () => {
  const root = shellEntry("root", "/tree");
  const child = shellEntry("child", "/tree/src", root.id);
  const tabs = client.createTabs(() =>
    Promise.reject(new Error("No promotion"))
  );
  tabs.update({
    directory: "/tree",
    directories: ["/tree", "/tree/src"],
    entries: [root, child],
    inbox: {
      projects: [],
      tasks: [{
        id: "task",
        name: "Task",
        directory: "/tree",
        sessions: [root.id],
        order: 0,
      }],
      seen: {},
      finishes: {},
      pathTemplates: [],
      supervision: { child: { state: "working", terminal: 0 } },
    },
  });
  tabs.preview(child.id);
  assertEquals(tabs.taskFor(child.id)?.id, "task");
  assertEquals(tabs.crumbs().map((crumb) => crumb.id), [root.id, child.id]);
  tabs.stop();
});

for (const prefix of ["opcv1", "opcv2"]) {
  Deno.test(`INV-D ${prefix}: preferred child wins but cold fallback chooses root`, async () => {
    const f = shellFixture();
    const root = shellEntry(`${prefix}-root`, "/repo");
    const child = shellEntry(`${prefix}-child`, "/repo", root.id);
    f.entries("local", [child, root]);
    try {
      const project = { sidecarId: "local", directory: "/repo" };
      assertEquals(await f.resources.projectSession(project), root.id);
      assertEquals(
        await f.resources.projectSession(project, child.id),
        child.id,
      );
    } finally {
      f.resources.stop();
    }
  });

  Deno.test(`INV-D ${prefix}: project click restores saved child route`, async () => {
    const f = shellFixture();
    const root = shellEntry(`${prefix}-root`, "/repo");
    const child = shellEntry(`${prefix}-child`, "/repo", root.id);
    f.entries("local", [root, child]);
    const prefs = {
      ...DEFAULT_PREFS,
      shellLayout: {
        ...DEFAULT_PREFS.shellLayout,
        projectLocations: [{
          sidecarId: "local",
          directory: "/repo",
          sessionID: child.id,
        }],
      },
    };
    const drafts = client.createDrafts();
    const actions = client.createSessionActions(f);
    const guard = client.createInputGuard({
      drafts,
      key: actions.key,
      confirm: () => true,
    });
    const location = { hash: "", pathname: "/", search: "" };
    const nav = client.createShellNavigation({
      ...f,
      actions,
      guard,
      drafts,
      confirm: () => true,
      presence: () => ({ focused: true, visible: true }),
      environment: {
        location,
        history: {
          state: undefined,
          replaceState() {},
          pushState(_state, _unused, url) {
            location.hash = String(url).slice(String(url).indexOf("#"));
          },
          go() {},
        },
        listen: () => () => {},
      },
    });
    try {
      nav.start();
      f.resources.receive("local", { t: "prefs", prefs });
      nav.openProject({ sidecarId: "local", directory: "/repo" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(f.session.state.selection?.sessionID, child.id);
      assertEquals(location.hash, `#/local/${root.id}/${child.id}`);
    } finally {
      nav.stop();
      f.resources.stop();
    }
  });

  for (const status of ["working", "blocked", "unseen-finished"] as const) {
    Deno.test(`SH1 ${prefix}: AXIOM 1 worktree child ${status} has a mandatory phantom`, () => {
      const f = shellFixture();
      const root = shellEntry(`${prefix}-root`, "/repo");
      const child = shellEntry(`${prefix}-child`, "/tree", root.id);
      if (status === "working") child.status = "busy";
      if (status === "blocked") child.attention.questions = 1;
      f.entries("local", [root, child]);
      f.resources.receive("local", {
        t: "inbox.snapshot",
        generation: "inv-d",
        revision: 0,
        summaryRevision: 0,
        inbox: {
          projects: [],
          tasks: [],
          seen: {},
          finishes: status === "unseen-finished" ? { [child.id]: 10 } : {},
          supervision: {
            [child.id]: {
              state: status === "working"
                ? "working"
                : status === "blocked"
                ? "needsYou"
                : "finishedUnseen",
              terminal: status === "unseen-finished" ? 10 : 0,
            },
          },
          pathTemplates: [],
          summaries: {
            "/tree": {
              directory: "/tree",
              status: "working",
              sessionCount: 1,
              unseenCount: 0,
              lastActivity: 2,
              authority: "current",
              scopes: ["/tree"],
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
        const project = { sidecarId: "local", directory: "/tree" };
        assertEquals(f.resources.projectEntries(project).map((e) => e.id), [
          child.id,
        ]);
        assertEquals(
          client.sessionTree([root, child], [], "/tree").flatMap((group) =>
            group.rows.map((row) => [row.session.id, row.depth])
          ),
          [[child.id, 0]],
        );
        const tabs = f.resources.tabs(project);
        assert(
          tabs.tabs().some((tab) =>
            tab.kind === "phantom" && tab.sessions.includes(child.id)
          ),
          "Child is visible in Sessions but no mandatory tab exists in its own worktree project",
        );
        tabs.preview(child.id);
        assertEquals(tabs.state.selected?.id, child.id);
        assertEquals(tabs.crumbs()[0], {
          id: root.id,
          helper: false,
          depth: 0,
          external: true,
        });
        assert(
          tabs.tabs().some((tab) => tab.id === tabs.state.selected?.id),
          "The open child's selected root tab must exist even across checkouts",
        );
      } finally {
        f.resources.stop();
      }
    });
  }
}
