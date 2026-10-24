// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createInbox, inboxProjects } from "@otk/client";
import type { InboxSnapshot, IndexEntry } from "@otk/protocol";

Deno.test("catalog merges tracked, indexed and template directories once, ordering discovery by source, activity and name", () => {
  const inbox: InboxSnapshot = {
    projects: [{
      directory: "/tracked",
      order: 0,
      added: true,
      inactive: false,
      lastVisit: 1,
    }],
    tasks: [],
    seen: {},
    finishes: { busy: 10 },
    pathTemplates: [],
    discovered: ["/zebra", "/alpha", "/indexed", "/tracked"],
  };
  const entry = (
    id: string,
    directory: string,
    timeUpdated: number,
  ): IndexEntry => ({
    id,
    directory,
    timeUpdated,
    timeCreated: 1,
    projectID: directory,
    title: id,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  });
  const entries = [
    entry("old", "/old", 1),
    entry("busy", "/indexed", 20),
    entry("duplicate", "/indexed", 5),
  ];
  const rows = inboxProjects(entries, inbox, 100);
  assertEquals(rows.map((p) => [p.directory, p.source, p.status]), [
    ["/tracked", "tracked", "idle"],
    ["/indexed", "index", "finished"],
    ["/old", "index", "idle"],
    ["/alpha", "template", "idle"],
    ["/zebra", "template", "idle"],
  ]);
  assertEquals(rows.find((p) => p.directory === "/alpha")?.visitText, "");
  inbox.projects.push({
    directory: "/indexed",
    order: 1,
    added: true,
    inactive: false,
    lastVisit: 100,
  });
  assertEquals(
    inboxProjects(entries, inbox, 100).filter((p) => p.directory === "/indexed")
      .map((p) => p.source),
    ["tracked"],
  );
});

Deno.test("catalog viewing records visits without activation; successful actions alone request activation", async () => {
  const calls: unknown[] = [];
  const inbox = createInbox({
    call(method, params) {
      calls.push([method, params]);
      return Promise.resolve(null) as never;
    },
  });
  await inbox.openProject("/discovered");
  await inbox.openSession("s", "/discovered");
  await inbox.act("/discovered", () => Promise.resolve("accepted"));
  try {
    await inbox.act("/discovered", () => Promise.reject(new Error("refused")));
  } catch { /* expected */ }
  assertEquals(calls, [
    ["projects.visit", { directory: "/discovered" }],
    ["projects.visit", { directory: "/discovered" }],
    ["sessions.seen", { sessionID: "s" }],
    ["projects.visit", { directory: "/discovered", active: true }],
  ]);
});
