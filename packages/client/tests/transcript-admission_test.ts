// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { createIndex, createTranscripts, SidecarConnection } from "@otk/client";
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import { shellEntry } from "./shell-fixture.ts";

Deno.test("a reduced metadata change touches only its transcript and borrowed helper consumers", () => {
  const index = createIndex();
  const sessions = Array.from(
    { length: 251 },
    (_, i) => ({ sidecarId: "scope", sessionID: `s${i}` }),
  );
  index.receive("scope", {
    t: "index.snapshot",
    rev: 0,
    entries: [
      ...sessions.map((target) => shellEntry(target.sessionID)),
      shellEntry("outside"),
    ],
  });
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.subscribe = () => {};
  connection.send = () => {};
  let reads = 0;
  const options = {
    connection: () => connection,
    entry: (server: string, id: string) => {
      reads++;
      return index.get(server, id);
    },
    changes: () => ({
      revision: 1,
      ids: ["outside"],
      structural: false,
      metadata: [],
    }),
  };
  const owner = createTranscripts(options);
  try {
    owner.setDemand({
      scope: { sidecarId: "scope", directory: "/p" },
      sessions,
      selected: sessions[0],
    });
    reads = 0;
    const frame = {
      t: "index.patch" as const,
      rev: 1,
      ops: [{
        op: "digest" as const,
        id: "outside",
        revision: 1,
        summary: { state: "ready" as const, revision: 1 },
        turns: { upsert: {}, remove: [] },
        deleted: null,
      }],
    };
    index.receive("scope", frame);
    owner.receive("scope", frame, true);
    assertEquals(
      reads,
      0,
      "Unrelated metadata cannot visit every warm transcript",
    );
  } finally {
    owner.stop();
    connection.rpc.close();
  }
});

Deno.test("scope admission indexes target priority once instead of rescanning membership for each queued comparison", () => {
  let reads = 0, admitted = 0;
  const sessions = Array.from({ length: 251 }, (_, i) => ({
    sidecarId: "scope",
    get sessionID() {
      reads++;
      return `s${i}`;
    },
  }));
  const connection = new SidecarConnection("http://example.test", {
    status() {},
    frame() {},
  }, { messages: fixtureMessagePolicy });
  connection.subscribe = () => {};
  connection.send = (frame) => {
    if (frame.t === "rpc") admitted++;
  };
  const owner = createTranscripts({
    connection: () => connection,
    entry: () => undefined,
  });
  try {
    owner.setDemand({
      scope: { sidecarId: "scope", directory: "/scale" },
      sessions,
      selected: sessions.at(-1),
    });
    assertEquals(admitted, 4);
    assert(
      reads <= sessions.length * 16,
      `251-member admission reread identity ${reads} times`,
    );
  } finally {
    owner.stop();
    connection.rpc.close();
  }
});
