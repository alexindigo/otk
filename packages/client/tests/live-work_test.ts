// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createLiveWork } from "../live-work.ts";
import * as work from "../live-work.ts";
import {
  createEntityStateStore,
  lamp,
  presentedEntity,
  sessionComposerLink,
  taskHelpers,
} from "../entity-state.ts";
import type {
  EntityState,
  HelperDisposition,
  TaskHelpers,
} from "@otk/protocol";

const helpers: TaskHelpers = {
  ids: ["helper"],
  counts: { running: 0, needsYou: 0, finished: 1 },
  lamps: {
    all: { state: "finished" },
    groups: {
      running: { state: "none" },
      needsYou: { state: "none" },
      finished: { state: "finished" },
    },
  },
};
const counts = { blocked: 0, finished: 1, unseen: 1, working: 0 };

Deno.test("helper clock selects one timestamp for the published disposition", () => {
  const entity = (
    helper: HelperDisposition,
    waitingSince?: number,
  ): EntityState => ({
    kind: "session",
    id: "helper",
    state: "working",
    previous: "none",
    counts,
    terminal: 120_000,
    evidence: {
      helper,
      work: true,
      permissions: 0,
      questions: 0,
      descendants: counts,
      ...(waitingSince === undefined ? {} : { waitingSince }),
      run: { startedAt: 60_000, endedAt: 120_000 },
    },
  });
  const now = 240_000;
  assertEquals(work.helperClock(entity("running"), now)?.time.text, "1m");
  assertEquals(
    work.helperClock(entity("finished"), now)?.time.spoken,
    "2 minutes ago",
  );
  assertEquals(
    work.helperClock(entity("needsYou", 210_000), now)?.time.text,
    "30s",
  );
  assertEquals(work.helperClock(entity("needsYou"), now), undefined);
});

Deno.test("live-work helper counts omit zero and agree with their verbs", () => {
  assertEquals(
    work.helperCountsLabel({ running: 4, needsYou: 3, finished: 221 }),
    "3 need you, 4 running, 221 finished",
  );
  const blocked = { running: 0, needsYou: 1, finished: 2 };
  assertEquals(
    work.helperCountsLabel(blocked),
    "1 needs you, 2 finished",
  );
  assertEquals(
    work.helperCountsLabel({ running: 0, needsYou: 0, finished: 0 }),
    "",
  );
});

Deno.test("composer link and helper lamp read separate published scopes", () => {
  const store = createEntityStateStore({
    read: () => ({
      "task:root": { ...presentedEntity("task", "root", "working"), helpers },
      "session:root": {
        ...presentedEntity("session", "root", "working"),
        composerLink: "running",
      },
    }),
  });
  const roster = taskHelpers(store, "task:root");
  assertEquals(lamp(roster?.lamps?.all), "finished");
  assertEquals(sessionComposerLink(store, "root"), "running");
  assertEquals(sessionComposerLink(store, "missing"), "none");
  store.stale(true);
  assertEquals(sessionComposerLink(store, "root"), "none");
});

Deno.test("live-work stop capability and admission survive presentation replacement", async () => {
  let finish!: () => void, calls = 0;
  const item = {
    id: "h",
    sessionID: "h",
    kind: "helper" as const,
    label: "Helper",
    title: "Work",
  };
  const shell = { ...item, kind: "shell" as const };
  let shellSupported = false;
  const stopShell = (id: string) => {
    assertEquals(id, "h");
    calls++;
    return Promise.resolve();
  };
  const owner = createLiveWork({
    items: () => [item, shell],
    stopHelper: () => async (id) => {
      assertEquals(id, "h");
      calls++;
      await new Promise<void>((resolve) => finish = resolve);
    },
    stopShell: () => shellSupported ? stopShell : undefined,
  });
  assertEquals(owner.canStop("shell/h"), false);
  assertEquals(owner.canStop("helper/h"), true);
  shellSupported = true;
  assertEquals(owner.canStop("shell/h"), true);
  assertEquals(owner.canStop("shell/absent"), false);
  const first = owner.stop("helper/h"), second = owner.stop("helper/h");
  assertEquals(first, second);
  await Promise.resolve();
  assertEquals(calls, 1);
  assertEquals(owner.stopping("helper/h"), true);
  const shellStop = owner.stop("shell/h");
  assertEquals(shellStop, owner.stop("shell/h"));
  await shellStop;
  assertEquals(calls, 2);
  assertEquals(owner.stopping("helper/h"), true);
  assertEquals(owner.stopping("shell/h"), false);
  finish();
  await first;
  assertEquals(owner.stopping("helper/h"), false);
});
