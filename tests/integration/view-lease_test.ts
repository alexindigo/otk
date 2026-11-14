// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ServerFrame } from "@otk/protocol";
import { test } from "../support/resources.ts";
import { fixture } from "../support/config.ts";
import { coreBackendFixture } from "../support/core-backend.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";

test("@load @attention attention leases contain only pending user requests and routing metadata when unrelated population doubles", async () => {
  const permission = {
    id: "ask",
    sessionID: "tstv1-pending",
    kind: "bash",
    title: "Approve command",
    patterns: ["true"],
    alwaysPatterns: [],
    time: 1,
    detail: { kind: "bash" as const, command: "true" },
  };
  const question = {
    id: "question",
    sessionID: "tstv1-pending",
    questions: [{
      text: "Continue?",
      options: [],
      multiple: false,
      custom: true,
    }],
  };
  const app = await coreBackendFixture(await fixture(), {
    permissions: {
      listPermissions: () => Promise.resolve([permission]),
      replyPermission: () => Promise.resolve(),
    },
    questions: {
      listQuestions: () => Promise.resolve([question]),
      answerQuestion: () => Promise.resolve(),
    },
  });
  const client = new WsClient(app.url);
  try {
    const seed = app.app.index.get("tstv1-core")!;
    const parent = {
      ...seed,
      id: "tstv1-route",
      directory: "/pending-project",
      title: "Pending parent",
      status: "busy" as const,
    };
    const child = {
      ...parent,
      id: permission.sessionID,
      parentID: parent.id,
      attention: { ...seed.attention, permissions: 1, questions: 1 },
    };
    app.app.index.upsertMetadata(parent);
    app.app.index.upsertMetadata(child);
    const grow = (count: number) => {
      for (let n = 0; n < count; n++) {
        app.app.index.upsertMetadata({
          ...seed,
          id: `tstv1-other-${n}`,
          directory: `/discovered/${n % 130}`,
          status: n % 2 ? "busy" : "idle",
        });
      }
    };
    grow(4000);
    await client.connect();
    const first = await client.wait((f) => f.t === "index.snapshot");
    assert(first.t === "index.snapshot");
    assertEquals(
      first.entries.map((e) => e.id).sort(),
      [child.id, parent.id].sort(),
    );
    for (const entry of first.entries) {
      assertEquals(entry.digest, {
        state: "digesting",
        revision: 0,
        turns: {},
      });
      assertEquals(entry.status, "idle");
      assertEquals(entry.timeUpdated, 0);
    }
    assertEquals(
      await client.rpc("permission.list", { sessionID: parent.id }),
      [permission],
    );
    assertEquals(await client.rpc("question.list", { sessionID: parent.id }), [
      question,
    ]);
    const at = client.frames.length;
    grow(8000);
    app.app.index.applyDigest({
      id: child.id,
      revision: 1,
      summary: { state: "ready", revision: 1, messageCount: 999 },
      turns: { upsert: {}, remove: [] },
      deleted: null,
    });
    await client.rpc("prefs.get", {});
    assertEquals(
      client.frames.slice(at).filter((f) => f.t === "index.patch"),
      [],
    );
    client.send({ t: "resnapshot" });
    await waitFor(
      () => client.frames.filter((f) => f.t === "index.snapshot").length,
      (n) => n === 2,
    );
    const second = client.frames.filter((f) => f.t === "index.snapshot")[1];
    assert(second.t === "index.snapshot");
    assertEquals(second.entries, first.entries);
    app.app.index.upsertMetadata({ ...child, attention: seed.attention });
    await client.wait((f) =>
      f.t === "index.patch" &&
      f.ops.filter((op) => op.op === "evict").length === 2
    );
    console.info("P4 ATTENTION", {
      unrelated: [4000, 8000],
      pending: 2,
      entries: [2, 2],
      frames: [1, 1],
      releasedEntries: 2,
    });
  } finally {
    await client.close();
    await app.app.stop();
  }
});

test("project and visible-row acquisition scopes inbox marks, policies and retained task membership", async () => {
  const app = await coreBackendFixture(await fixture(), {
    permissions: {
      listPermissions: () => Promise.resolve([]),
      replyPermission: () => Promise.resolve(),
    },
  });
  const control = new WsClient(app.url), client = new WsClient(app.url);
  try {
    const seed = app.app.index.get("tstv1-core")!;
    const other = { ...seed, id: "tstv1-other", directory: "/another-project" };
    const row = { ...seed, id: "tstv1-visible-row" };
    app.app.index.upsertMetadata(other);
    app.app.index.upsertMetadata(row);
    app.app.backend.core.identities = (ids) =>
      Promise.resolve(ids.flatMap((id) => {
        const value = app.app.index.getMetadata(id);
        return value ? [value] : [];
      }));
    await control.connect();
    const task = await control.rpc<{ id: string }>("tasks.create", {
      directory: other.directory,
      name: "Other task",
      sessions: [other.id],
    });
    await control.rpc("sessions.seen", { sessionID: other.id, terminal: 0 });
    await control.rpc("permission.auto", {
      sessionID: other.id,
      enabled: true,
    });
    client.lease({
      directory: seed.directory,
      selected: seed.id,
      crumbs: [],
      rows: [],
    });
    await client.connect();
    const baseline = await client.rpc<
      { inbox: import("@otk/protocol").InboxSnapshot }
    >("inbox.get", {});
    assertEquals(baseline.inbox.tasks, []);
    assertEquals(baseline.inbox.seen, {});
    const policies = await client.wait((frame) => frame.t === "approvals");
    assert(policies.t === "approvals");
    assertEquals(policies.approvals.enabled, []);
    await control.rpc("frecency.bump", {
      sessionID: other.id,
      path: "other-project-private.txt",
    });
    await client.rpc("prefs.get", {});
    assertEquals(
      client.frames.filter((frame) => frame.t === "frecency.patch"),
      [],
    );
    assert(
      !client.frames.some((frame) =>
        frame.t === "index.snapshot" &&
        frame.entries.some((e) => e.id === row.id)
      ),
    );
    client.lease({
      directory: seed.directory,
      selected: seed.id,
      crumbs: [],
      rows: [row.id],
    });
    await client.wait((frame) =>
      frame.t === "index.patch" &&
      frame.ops.some((op) => op.op === "upsert" && op.entry.id === row.id)
    );
    client.lease({
      directory: other.directory,
      selected: other.id,
      crumbs: [],
      rows: [],
    });
    await client.wait((frame) =>
      frame.t === "index.patch" &&
      frame.ops.some((op) => op.op === "evict" && op.id === row.id)
    );
    await waitFor(
      () =>
        client.frames.filter((frame) => frame.t === "inbox.snapshot")
          .some((frame) =>
            frame.t === "inbox.snapshot" &&
            frame.inbox.tasks.some((value) => value.id === task.id)
          ),
      Boolean,
    );
    const acquired = await client.rpc<
      { inbox: import("@otk/protocol").InboxSnapshot }
    >("inbox.get", {});
    assertEquals(acquired.inbox.tasks.map((value) => value.id), [task.id]);
    assertEquals(acquired.inbox.seen[other.id], 0);
    await client.wait((frame) =>
      frame.t === "approvals" && frame.approvals.enabled.includes(other.id)
    );
    client.lease({
      directory: seed.directory,
      selected: seed.id,
      crumbs: [],
      rows: [],
    });
    await client.rpc("prefs.get", {});
    assertEquals(
      (await control.rpc<{ id: string }[]>("tasks.list", {
        directory: other.directory,
      }))[0].id,
      task.id,
    );
  } finally {
    await client.close();
    await control.close();
    await app.app.stop();
  }
});

test("@load @transport view leases exclude unrelated sessions and fence replacements", async () => {
  const app = await coreBackendFixture(await fixture());
  const client = new WsClient(app.url);
  try {
    const seed = app.app.index.get("tstv1-core")!;
    for (let n = 0; n < 4000; n++) {
      app.app.index.upsertMetadata({
        ...seed,
        id: `tstv1-unrelated-${n}`,
        directory: `/discovered/${n % 130}`,
      });
    }
    await client.connect();
    await client.wait((f) => f.t === "index.snapshot");
    assertEquals(
      client.frames.filter((f) => f.t === "index.snapshot")
        .flatMap((f) => f.t === "index.snapshot" ? f.entries : []),
      [],
    );
    client.send({
      t: "view",
      epoch: 1,
      directory: seed.directory,
      selected: seed.id,
      crumbs: [],
      rows: [],
    });
    await client.wait((f) =>
      f.t === "index.patch" &&
      f.ops.some((op) => op.op === "upsert" && op.entry.id === seed.id)
    );
    client.send({ t: "resnapshot" });
    const small = await client.wait((f) =>
      f.t === "index.snapshot" && f.entries.some((e) => e.id === seed.id)
    );
    assert(small.t === "index.snapshot");
    assertEquals(small.entries.map((e) => e.id), [seed.id]);
    const ids = (frames: ServerFrame[]) =>
      frames.flatMap((f) =>
        f.t === "index.snapshot"
          ? f.entries.map((e) => e.id)
          : f.t === "index.patch"
          ? f.ops.map((op) => op.op === "upsert" ? op.entry.id : op.id)
          : []
      );
    const before = client.frames.length;
    for (let n = 0; n < 8000; n++) {
      app.app.index.upsertMetadata({
        ...seed,
        id: `tstv1-unrelated-${n}`,
        directory: `/discovered/${n % 130}`,
        timeUpdated: 2,
      });
    }
    app.app.index.upsertMetadata({ ...seed, title: "Leased change" });
    await client.wait((f) =>
      f.t === "index.patch" &&
      f.ops.some((op) =>
        op.op === "upsert" && op.entry.title === "Leased change"
      )
    );
    assertEquals(ids(client.frames.slice(before)), [seed.id]);
    client.send({ t: "resnapshot" });
    const large = await client.wait((f) =>
      f.t === "index.snapshot" &&
      f.entries.some((e) => e.title === "Leased change")
    );
    assert(large.t === "index.snapshot");
    assertEquals(
      large.entries.map((e) => e.id),
      small.entries.map((e) => e.id),
    );
    // A full publication minute, with fixed demand and a doubled unrelated
    // population. Each half has exactly 30 leased updates, zero unrelated IDs.
    const halves: number[][] = [[], []];
    for (let second = 0; second < 60; second++) {
      const at = client.frames.length;
      app.app.index.upsertMetadata({
        ...seed,
        id: `tstv1-unrelated-${second}`,
        directory: `/discovered/${second % 130}`,
        timeUpdated: second + 3,
      });
      app.app.index.upsertMetadata({
        ...seed,
        title: `Minute ${second}`,
        timeUpdated: second + 3,
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const published = ids(client.frames.slice(at));
      assertEquals(published, [seed.id]);
      halves[second < 30 ? 0 : 1].push(published.length);
    }
    assertEquals(halves[0], halves[1]);
    const inbox = await client.rpc<
      { inbox: import("@otk/protocol").InboxSnapshot }
    >("inbox.get", {});
    assertEquals(Object.keys(inbox.inbox.summaries ?? {}).length, 131);
    assertEquals(inbox.inbox.tasks, []);
    assertEquals(inbox.inbox.seen, {});
    assertEquals(inbox.inbox.finishes, {});
    console.info("P4 PUBLICATION", {
      discovered: 130,
      unrelated: [4000, 8000],
      leasedEntries: 1,
      minuteIndexEntries: 60,
      summaries: 131,
    });
    client.send({ t: "view", epoch: 2, crumbs: [], rows: [] });
    await client.wait((f) =>
      f.t === "index.patch" &&
      f.ops.some((op) => op.op === "evict" && op.id === seed.id)
    );
    client.send({
      t: "view",
      epoch: 1,
      selected: seed.id,
      crumbs: [],
      rows: [],
    });
    app.app.index.upsertMetadata({ ...seed, title: "Must stay evicted" });
    await client.rpc("prefs.get", {});
    assert(
      !client.frames.some((f) =>
        f.t === "index.patch" &&
        f.ops.some((op) =>
          op.op === "upsert" && op.entry.title === "Must stay evicted"
        )
      ),
    );
  } finally {
    await client.close();
    await app.app.stop();
  }
});
