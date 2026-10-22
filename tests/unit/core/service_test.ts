// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../support/resources.ts";
import { ownSocket } from "../../support/ws-client.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
// @deno-types="npm:@types/ws@8.18.1"
import WebSocket from "ws";
import type { Harness } from "@otk/harness";
import { OtkDb, Prefs, prefsMigrations } from "@otk/store";
import {
  prefsOptions,
  registerPrefs,
  registerSessions,
  RpcRegistry,
  startCore,
} from "../../../core/mod.ts";
import { PROTOCOL_VERSION, type ServerFrame } from "@otk/protocol";
import { cfg, fixture } from "./support.ts";

test("core service with a composed backend/assets discovers HTTP routes and advertises capabilities to an actual WS consumer", async () => {
  const root = await fixture(), settings = cfg();
  settings.server.port = 0;
  settings.auth.type = "none";
  settings.state.path = join(root, "state");
  await Deno.writeTextFile(
    join(root, "index.html"),
    "<head></head><p>Caller assets</p>",
  );
  await Deno.mkdir(join(root, "assets"));
  await Deno.writeTextFile(join(root, "assets/app.js"), "/* Caller script */");
  const session = {
    id: "s",
    projectID: "p",
    directory: root,
    title: "Caller",
    time: { created: 1, updated: 1 },
    archived: false,
  };
  const harness: Harness = {
    core: {
      kind: "external",
      version: "1",
      start: (sink) => {
        sink.connection("connected");
        return Promise.resolve();
      },
      stop: async () => {},
      subscriptions() {},
      getSession: () => Promise.resolve(session),
      listChildren: () => Promise.resolve([]),
      listMessages: () => Promise.resolve([]),
      createSession: () => Promise.resolve(session),
    },
    capabilities: { prompt: undefined },
  };
  const db = new OtkDb(settings.state.path, [prefsMigrations]),
    prefs = new Prefs(db, prefsOptions),
    rpc = new RpcRegistry(harness, db);
  registerSessions(rpc, harness);
  registerPrefs(rpc, harness, prefs);
  const app = await startCore({
    cfg: settings,
    backend: harness,
    store: db,
    prefs,
    rpc,
    staticRoot: root,
  });
  const base = `http://127.0.0.1:${app.server.addr.port}`;
  let ws: WebSocket | undefined;
  try {
    const staticPage = await fetch(base + "/");
    assert((await staticPage.text()).includes("Caller assets"));
    const asset = await fetch(base + "/assets/app.js");
    assertEquals(
      asset.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    assertEquals(await asset.text(), "/* Caller script */");
    const spa = await fetch(base + "/projects/demo");
    assertEquals(spa.headers.get("cache-control"), "no-cache");
    assertEquals(
      await spa.text(),
      '<head><base href="../"></head><p>Caller assets</p>',
    );
    const missingApi = await fetch(base + "/api/missing");
    assertEquals(missingApi.status, 404);
    assertEquals(await missingApi.json(), { code: "not_found" });
    const health = await fetch(base + "/api/health");
    assertEquals((await health.json()).harness, {
      kind: "external",
      version: "1",
    });
    const forbidden = await fetch(base + "/api/logout", { method: "POST" });
    assertEquals(forbidden.status, 403);
    assertEquals((await forbidden.json()).code, "origin");
    const frames: ServerFrame[] = [];
    ws = new WebSocket(base.replace(/^http/, "ws") + "/api/ws", {
      headers: { Origin: base },
    });
    ownSocket(ws);
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    ws.send(JSON.stringify({ t: "hello", protocol: PROTOCOL_VERSION }));
    const wait = async (predicate: (frame: ServerFrame) => boolean) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const found = frames.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("WS frame timeout");
    };
    const welcome = await wait((frame) => frame.t === "welcome");
    assert(welcome.t === "welcome");
    assertEquals(welcome.sidecar.harness.capabilities, []);
    ws.send(
      JSON.stringify({
        t: "rpc",
        id: "owned",
        method: "session.get",
        params: { sessionID: "s" },
      }),
    );
    assertEquals(
      await wait((frame) => frame.t === "rpc.result" && frame.id === "owned"),
      { t: "rpc.result", id: "owned", ok: true, result: session },
    );
    ws.send(
      JSON.stringify({
        t: "rpc",
        id: "absent",
        method: "session.prompt",
        params: {},
      }),
    );
    assertEquals(
      await wait((frame) => frame.t === "rpc.result" && frame.id === "absent"),
      {
        t: "rpc.result",
        id: "absent",
        ok: false,
        error: { code: "method", message: "Unknown method: session.prompt" },
      },
    );
  } finally {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        ws!.once("close", resolve);
        ws!.close();
      });
    }
    await app.stop();
  }
});
