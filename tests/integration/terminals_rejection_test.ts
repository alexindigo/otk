// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import type { Harness } from "@otk/harness";
import type { RequestEvent } from "@otk/protocol";
import { OtkDb, Requests, requestsMigrations } from "@otk/store";
import { RequestCoordinator, RpcRegistry } from "../../core/mod.ts";
import { registerTerminals } from "../../core/features/terminals.ts";
import { TerminalHost } from "../../core/terminals/host.ts";
import { embeddedPtyBinary } from "../../core/terminals/binary.ts";
import { DaemonResponseError } from "../../core/terminals/daemon.ts";
import { cfg } from "../support/config.ts";
import { resources, tempDir, test } from "../support/resources.ts";

for (
  const mode of [
    "spawn",
    "relative-spawn",
    "close-race",
    "close-pre-send",
    "close-read-loss",
    "pre-send",
    "transport-loss",
    "post-spawn-error",
    "ambiguous-spawn-error",
  ] as const
) {
  const uncertain = mode === "transport-loss" || mode === "post-spawn-error" ||
    mode === "ambiguous-spawn-error";
  test(`terminal coordinator ${mode}: definite rejection terminates, transport loss remains uncertain`, async () => {
    const root = await tempDir("terminal-reject-");
    const host = await TerminalHost.start({
      statePath: join(root, "state"),
      dataDir: join(root, "data"),
      environment: {
        ...Deno.env.toObject(),
        INVOCATION_ID: "",
        OTK_PTY_BIN: fromFileUrl(embeddedPtyBinary()),
        SHELL: mode === "spawn"
          ? "/nonexistent-p9-shell"
          : mode === "relative-spawn"
          ? "nonexistent-p9-shell"
          : mode === "ambiguous-spawn-error"
          ? "terminal writer"
          : "/bin/sh",
      },
      signal: new AbortController().signal,
    });
    const daemon = await host.daemon();
    resources().defer("stop rejection daemon", async () => {
      await daemon.shutdown();
      await host.stop();
    });
    const db = new OtkDb(join(root, "db"), [requestsMigrations], {
      busyms: 5000,
    });
    resources().defer("close rejection database", () => db.close());
    const receipts = new Requests(db);
    const harness = {
      core: {
        identities: (ids: string[]) =>
          Promise.resolve(ids.map((id) => ({ id, directory: root }))),
      },
      capabilities: {},
    } as unknown as Harness;
    const registry = new RpcRegistry(harness, db);
    registerTerminals(registry, host);
    let terminalID: string | undefined;
    if (
      mode === "close-race" || mode === "close-pre-send" ||
      mode === "close-read-loss"
    ) {
      terminalID = String((await host.create("tstv1-reject", root, 80, 24)).id);
      if (mode === "close-race") {
        const close = host.close.bind(host);
        host.close = async (directory, id) => {
          // Another caller removes it after RPC preflight but before host.close.
          await daemon.request({ op: "terminate", id });
          return await close(directory, id);
        };
      } else {
        const request = daemon.request.bind(daemon);
        daemon.request = async (value) => {
          if (value.op === "get") {
            if (mode === "close-read-loss") {
              throw new Error("lost metadata response before termination");
            }
            await daemon.disconnect();
          }
          return await request(value);
        };
      }
    } else if (uncertain) {
      const request = daemon.request.bind(daemon);
      daemon.request = async (value) => {
        if (value.op !== "create_pty") return await request(value);
        if (mode === "post-spawn-error") await request(value);
        throw (
          mode === "transport-loss"
            ? new Error("lost daemon response")
            : new DaemonResponseError(
              mode === "ambiguous-spawn-error"
                ? "failed to spawn terminal writer: injected post-spawn failure"
                : "failed to clone PTY reader: injected post-spawn failure",
            )
        );
      };
    }
    const coordinator = new RequestCoordinator({
      registry,
      receipts,
      policy: cfg().requests,
    });
    await coordinator.start();
    resources().defer("stop rejection coordinator", () => coordinator.stop());
    const ref = {
      id: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      window: coordinator.window().id,
    };
    const events: RequestEvent[] = [];
    const key = {
      principal: "local",
      client_id: ref.clientID,
      intent_key: ref.key,
    };
    const prepare = host.prepareCreate.bind(host);
    host.prepareCreate = async (...args) => {
      assertEquals(
        receipts.get(key)?.dispatched_at,
        null,
        "local shell preparation precedes dispatch fence",
      );
      const create = await prepare(...args);
      if (mode === "pre-send") await daemon.disconnect();
      return create;
    };
    const recipient = {
      send: (event: RequestEvent) => events.push(event),
      lease: { id: "test", signal: new AbortController().signal, defer() {} },
    };
    await coordinator.accept("local", {
      t: "request",
      ref,
      method: terminalID ? "terminal.close" : "terminal.create",
      params: terminalID
        ? { sessionID: "tstv1-reject", terminalID }
        : { sessionID: "tstv1-reject", cols: 80, rows: 24 },
    }, recipient);
    await coordinator.idle();
    const record = receipts.get({
      principal: "local",
      client_id: ref.clientID,
      intent_key: ref.key,
    })!;
    assert(
      record.dispatched_at !== null,
      "rejection/uncertainty must be observed after dispatch",
    );
    if (uncertain) {
      assertEquals(record.state, "reconciling");
      assert(!events.some((e) => e.t === "request.result"));
      if (mode === "post-spawn-error") {
        const before = await daemon.request({ op: "list", mode: "pty" });
        assert(before.type === "processes");
        assertEquals(before.processes.length, 1);
        await coordinator.accept("local", {
          t: "request",
          ref: { ...ref, id: crypto.randomUUID() },
          method: "terminal.create",
          params: { sessionID: "tstv1-reject", cols: 80, rows: 24 },
        }, recipient);
        await coordinator.idle();
        const after = await daemon.request({ op: "list", mode: "pty" });
        assert(after.type === "processes");
        assertEquals(
          after.processes.map((process) => process.id),
          before.processes.map((process) => process.id),
        );
      }
    } else {
      const result = events.find((event) => event.t === "request.result");
      assert(
        result?.t === "request.result" && !result.outcome.ok,
        JSON.stringify({ record, events }),
      );
      assertEquals(record.state, "failed");
      assertEquals(
        record.error_code,
        mode === "close-race"
          ? "not-found"
          : mode === "pre-send" || mode === "close-pre-send" ||
              mode === "close-read-loss"
          ? "terminal-unavailable"
          : "terminal-spawn-failed",
      );
      if (mode !== "pre-send" && mode !== "close-pre-send") {
        const list = await daemon.request({ op: "list", mode: "pty" });
        assert(list.type === "processes");
        assertEquals(
          list.processes.map((process) => String(process.id)),
          mode === "close-read-loss" ? [terminalID!] : [],
        );
      }
    }
  });
}
