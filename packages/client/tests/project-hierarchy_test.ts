// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { inboxProjects, projectHierarchy } from "./supervision-fixture.ts";
import type { InboxSnapshot, ProjectSummary } from "@otk/protocol";

Deno.test("scalar project hierarchy keeps mandatory leaves in Active and quiet archived siblings in Inactive without acquired sessions", () => {
  const summary = (
    directory: string,
    status: ProjectSummary["status"],
  ): ProjectSummary => ({
    directory,
    hasSessions: true,
    status,
    sessionCount: 1,
    unseenCount: 0,
    lastActivity: 1,
    authority: "stale",
    topology: {
      repoID: "repo",
      canonicalRoot: "/repo",
      leafDirectory: directory,
      ...(directory !== "/repo" ? { parentDirectory: "/repo" } : {}),
    },
  });
  const inbox: InboxSnapshot = {
    projects: ["/tree/one", "/tree/quiet", "/repo"].map((directory, order) => ({
      directory,
      order,
      added: true,
      lastVisit: 1,
      inactive: true,
    })),
    tasks: [],
    seen: {},
    finishes: {},
    pathTemplates: [],
    summaries: Object.fromEntries(
      [
        summary("/repo", "working"),
        summary("/tree/one", "working"),
        summary("/tree/quiet", "none"),
      ].map((s) => [s.directory, s]),
    ),
  };
  const rows = inboxProjects([], inbox, 5);
  assertEquals(rows.map((r) => [r.directory, r.group, r.depth ?? 0]), [
    ["/repo", "active", 0],
    ["/tree/one", "active", 1],
    ["/tree/quiet", "inactive", 1],
  ]);
  assertEquals(rows[2].parentLabel, "repo");
  const servers = ["a", "b"].flatMap((sidecarId) =>
    rows.map((r) => ({ ...r, sidecarId }))
  );
  assertEquals(projectHierarchy(servers).map((r) => r.sidecarId), [
    "a",
    "a",
    "a",
    "b",
    "b",
    "b",
  ]);
  inbox.summaries!["/repo"].status = "none";
  inbox.summaries!["/tree/one"].status = "none";
  inbox.projects[0].inactive = false;
  const contextual = inboxProjects([], inbox, 5);
  assertEquals(contextual[0].group, "active");
  assertEquals(contextual[0].inactivePolicy, true);
  assertEquals(contextual[1].directory, "/tree/one");
});
