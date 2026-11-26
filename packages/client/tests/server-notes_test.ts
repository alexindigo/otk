// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { serverNote } from "../server-notes.ts";
import type { ServerContinuity } from "../server-continuity.ts";

Deno.test("server notes are selected from continuity and use one action and dismissal key", () => {
  const note = (continuity: ServerContinuity, local = true) =>
    serverNote({ id: "x", label: "Lab", continuity }, local);
  const offline = { kind: "unreachable", since: 12 } as const;
  assertEquals(note(offline), {
    id: "server/x",
    kind: "server",
    title: "Can't reach OTK",
    body: "Retrying. Drafts are kept.",
    dismissalKey: "unreachable:12",
    actions: [{
      label: "Reload",
      command: "server.reload",
      args: { sidecarId: "x" },
      default: true,
    }],
  });
  assertEquals(note({ kind: "away", since: 12 }), undefined);
  assertEquals(note({ kind: "live" }), undefined);
  assertEquals(
    note({ kind: "away", since: 12, refused: "Still offline" }, false),
    {
      ...note(offline)!,
      title: "Can't reach Lab",
      body: "Still offline",
    },
  );
  assertEquals(note({ kind: "updated", build: "b" }), {
    ...note(offline)!,
    title: "OTK was updated",
    body: "Drafts are kept",
    dismissalKey: "updated:b",
  });
  assertEquals(
    note({ kind: "updated", protocol: 999 }, false)?.dismissalKey,
    "updated:protocol-999",
  );
  const restart = { instance: "two", updated: false };
  assertEquals(note({ kind: "live", restarted: restart }), {
    id: "server/x",
    kind: "info",
    title: "OTK server restarted",
    body: "Reconnected",
    dismissalKey: "restarted:two",
    actions: [],
  });
  assertEquals(
    note({ kind: "live", restarted: restart }, false)?.title,
    "Lab restarted",
  );
  assertEquals(
    note({ kind: "live", restarted: { ...restart, updated: true } }, false)
      ?.title,
    "Lab was updated",
  );
});
