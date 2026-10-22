// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { SessionIndex } from "@otk/harness";
import type { IndexEntry } from "@otk/protocol";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { waitFor } from "../../../tests/support/opencode.ts";
import { Opencode1Adapter } from "../adapter.ts";

for (const database of ["missing", "incompatible", "no hints"] as const) {
  Deno.test(`bootstrap inventories paged session directories before readiness with ${database} SQLite`, async () => {
    const settings = cfg(), root = await fixture();
    settings.harness.db = join(root, "native.db");
    if (database !== "missing") {
      const db = new DatabaseSync(settings.harness.db);
      db.exec(
        database === "incompatible"
          ? "CREATE TABLE session(id TEXT)"
          : "CREATE TABLE session(id TEXT,directory TEXT,time_updated INTEGER); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)",
      );
      db.close();
    }
    const seeds = [
      ["busy", "/first"],
      ["retry", "/first"],
      ["parent", "/first"],
      ["permission", "/second"],
      ["question", "/third"],
    ].map(([id, directory]) => ({
      id,
      directory,
      ...(id === "permission" || id === "question"
        ? { parentID: "parent" }
        : {}),
      projectID: "project",
      title: id,
      time: { created: Date.now(), updated: Date.now() },
    }));
    const retry = { type: "retry", attempt: 2, message: "Waiting", next: 123 };
    if (database === "no hints") {
      const db = new DatabaseSync(settings.harness.db);
      const session = db.prepare("INSERT INTO session VALUES(?,?,?)");
      const message = db.prepare("INSERT INTO message VALUES(?,?,?)");
      for (const seed of seeds) {
        session.run(seed.id, seed.directory, seed.time.updated);
        message.run(
          `message-${seed.id}`,
          seed.id,
          JSON.stringify({
            role: "assistant",
            time: { completed: Date.now() },
          }),
        );
      }
      db.close();
    }
    const request = {
      id: "pending-permission",
      sessionID: "permission",
      permission: "bash",
      patterns: ["pwd"],
      always: ["*"],
      metadata: { command: "pwd" },
    };
    let stream!: ReadableStreamDefaultController<Uint8Array>,
      ready = 0,
      resets = 0;
    const reads: string[] = [], snapshots: IndexEntry[][] = [];
    const index = new SessionIndex();
    const fetcher: typeof fetch = (input, options) => {
      const url = new URL(String(input)),
        directory = url.searchParams.get("directory");
      if (url.pathname === "/global/health") {
        return Promise.resolve(Response.json({ version: "1.18.34" }));
      }
      if (url.pathname === "/experimental/session") {
        return Promise.resolve(
          url.searchParams.has("cursor")
            ? Response.json(seeds.slice(3))
            : Response.json(seeds.slice(0, 3), {
              headers: { "x-next-cursor": "page2" },
            }),
        );
      }
      if (
        ["/session/status", "/permission", "/question"].includes(url.pathname)
      ) {
        reads.push(`${url.pathname}:${directory}`);
        const value = url.pathname === "/session/status"
          ? directory === "/first" ? { busy: { type: "busy" }, retry } : {}
          : url.pathname === "/permission"
          ? directory === "/second" ? [request] : []
          : directory === "/third"
          ? [{ id: "pending-question", sessionID: "question" }]
          : [];
        return Promise.resolve(Response.json(value));
      }
      assertEquals(url.pathname, "/global/event");
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(new TextEncoder().encode(
                'data: {"payload":{"type":"server.connected","properties":{}}}\n\n',
              ));
              options?.signal?.addEventListener(
                "abort",
                () => controller.close(),
                { once: true },
              );
            },
          }),
        ),
      );
    };
    const adapter = new Opencode1Adapter(settings, undefined, fetcher);
    try {
      await adapter.core.start({
        index,
        connection(state) {
          if (state === "connected") {
            snapshots.push([...index.values()]);
            ready++;
          }
        },
        indexReset: (entries) => {
          index.reset(entries);
          resets++;
        },
        indexUpsert: (entry) => index.upsert(entry),
        indexRemove: (id) => index.remove(id),
        content() {},
        resync() {},
      });
      await waitFor(() => ready, (count) => count === 1);
      const check = async () => {
        assertEquals(
          index.get("busy")?.status,
          "busy",
          "Already-running work was hidden as idle",
        );
        assertEquals(index.get("retry")?.retry, {
          attempt: 2,
          message: "Waiting",
          next: 123,
        });
        assertEquals(index.get("permission")?.attention.permissions, 1);
        assertEquals(index.get("question")?.attention.questions, 1);
        assertEquals(index.get("parent")?.attention.childPermissions, 1);
        assertEquals(index.get("parent")?.attention.childQuestions, 1);
        assertEquals(
          (await adapter.capabilities.permissions.listPermissions("parent"))
            .map((r) => r.id),
          [request.id],
        );
        assertEquals(
          reads.splice(0).sort(),
          ["/first", "/second", "/third"].flatMap((dir) =>
            ["/session/status", "/permission", "/question"].map((path) =>
              `${path}:${dir}`
            )
          ).sort(),
        );
      };
      await check();
      assertEquals(
        snapshots[0].find((entry) => entry.id === "busy")?.status,
        "busy",
        "Readiness preceded activity reconciliation",
      );
      stream.enqueue(new TextEncoder().encode(
        'data: {"payload":{"type":"server.instance.disposed","properties":{}}}\n\n',
      ));
      await waitFor(() => resets, (count) => count === 2);
      await check();
    } finally {
      await adapter.core.stop();
      await Deno.remove(root, { recursive: true });
    }
  });
}
