// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createLiveWork, runningWork } from "../live-work.ts";
import type { ClientTabs } from "../tabs.ts";
import type { InboxSnapshot, IndexEntry, Message } from "@otk/protocol";

Deno.test("live inventory is independent of transcript paging and unrelated sessions", () => {
  const current = {
    id: "s",
    title: "Session",
    activity: {
      work: {
        fresh: true,
        keys: ["shell-live"],
        items: [{
          id: "shell-live",
          kind: "shell",
          label: "Shell",
          title: "Live shell",
          startedAt: 123,
        }],
      },
    },
  } as unknown as IndexEntry;
  const input = {
    tabs: { working: () => [] } as unknown as ClientTabs,
    inbox: {} as InboxSnapshot,
    sessionID: "s",
    entry: (id: string) => id === "s" ? current : undefined,
    messages: [],
    connected: true,
  };
  const items = runningWork(input);
  assertEquals(items.map((item) => [item.id, item.title, item.startedAt]), [[
    "shell/shell-live",
    "Live shell",
    123,
  ]]);
  assertEquals(runningWork({ ...input, messages: [] }), items);
  const historical: Message = {
    id: "old",
    sessionID: "s",
    role: "context",
    time: { created: 1 },
    parts: [{
      kind: "external",
      id: "old-shell",
      name: "invented/shell",
      activity: {
        kindLabel: "Shell",
        title: "Historical shell",
        work: { kind: "shell" },
        state: {
          key: "active",
          label: "Running",
          facts: { active: true, terminal: false },
        },
        layout: "row",
        category: "record",
        tone: "normal",
      },
    }],
  };
  assertEquals(runningWork({ ...input, messages: [historical] }), items);
  assertEquals(runningWork({ ...input, sessionID: "other" }), []);
  current.activity!.work!.fresh = false;
  assertEquals(runningWork(input), []);
});

Deno.test("live-work stop capability and admission survive presentation replacement", async () => {
  let finish!: () => void, calls = 0;
  const item = {
    id: "helper/h",
    sessionID: "h",
    kind: "helper" as const,
    label: "Helper",
    title: "Work",
  };
  const shell = { ...item, id: "shell/s", kind: "shell" as const };
  const owner = createLiveWork({
    items: () => [item, shell],
    stopHelper: () => async (id) => {
      assertEquals(id, "h");
      calls++;
      await new Promise<void>((resolve) => finish = resolve);
    },
  });
  assertEquals(owner.canStop(shell.id), false);
  assertEquals(owner.canStop(item.id), true);
  const first = owner.stop(item.id), second = owner.stop(item.id);
  assertEquals(first, second);
  await Promise.resolve();
  assertEquals(calls, 1);
  assertEquals(owner.stopping(item.id), true);
  finish();
  await first;
  assertEquals(owner.stopping(item.id), false);
});

Deno.test("helper elapsed starts at the owned execution, never helper session age", () => {
  const helper = {
    id: "helper",
    title: "Task",
    digest: {
      helper: { progress: { state: "known", value: { time: { start: 1 } } } },
    },
    activity: {
      work: {
        fresh: true,
        keys: ["run"],
        items: [{
          id: "run",
          kind: "execution",
          label: "Execution",
          title: "Task",
          startedAt: 10000,
        }],
      },
    },
  } as unknown as IndexEntry;
  const input = {
    tabs: {
      working: () => [{
        id: "helper",
        kind: "member" as const,
        helper: true,
        depth: 1,
      }],
    },
    inbox: {} as InboxSnapshot,
    sessionID: "root",
    connected: true,
    entry: (id: string) => id === "helper" ? helper : undefined,
  };
  assertEquals(runningWork(input)[0].startedAt, 10000);
  helper.activity!.work!.items = [];
  assertEquals(runningWork(input)[0].startedAt, undefined);
});
