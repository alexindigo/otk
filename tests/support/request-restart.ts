// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { RequestEvent, RequestRef, TaskRecord } from "@otk/protocol";
import { nativeFixture } from "./native-fixture.ts";
import { preparedBinary } from "./prepared-binaries.ts";
import { serve } from "./http.ts";
import { freePort, waitFor } from "./opencode.ts";
import { ownedProcess } from "./process.ts";
import { resources, tempDir } from "./resources.ts";
import { WsClient } from "./ws-client.ts";

/** Same real-process proof for source and the off-source shipped executable. */
export async function qualifyRequestRestart(compiled: boolean): Promise<void> {
  const root = await tempDir("rq-"),
    source = fromFileUrl(new URL("../../", import.meta.url));
  const binary = compiled ? await preparedBinary() : "";
  const f = await nativeFixture();
  const remoteCommitted = Promise.withResolvers<void>(),
    deliver = Promise.withResolvers<void>();
  let creates = 0, lostNativeID = "";
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const url = new URL(request.url);
      const response = await fetch(
        new Request(f.oc.url + url.pathname + url.search, request),
      );
      if (
        request.method !== "POST" || url.pathname !== "/session"
      ) return response;
      creates++;
      const bytes = await response.arrayBuffer();
      assert(response.ok);
      lostNativeID = JSON.parse(new TextDecoder().decode(bytes)).id;
      remoteCommitted.resolve();
      await deliver.promise;
      return new Response(bytes, {
        status: response.status,
        headers: response.headers,
      });
    },
  );
  resources().defer("lost native response proxy", () => proxy.shutdown());
  const port = freePort(),
    url = `http://127.0.0.1:${port}`,
    state = join(root, "state");
  const config = join(root, "otk.toml");
  await Deno.writeTextFile(
    config,
    `[server]\nport=${port}\n[auth]\ntype="none"\n[state]\npath=${
      JSON.stringify(state)
    }\n[harness]\nurl="http://127.0.0.1:${proxy.addr.port}"\ndb=${
      JSON.stringify(f.oc.db)
    }\n[digest]\nretryms=10\ncpu=1\nmemoryreserve=1\n`,
  );
  let generation = 0;
  const run = async () => {
    const index = ++generation;
    const env = Object.fromEntries(
      Object.entries(Deno.env.toObject()).filter(([key]) =>
        !key.startsWith("OTK_")
      ),
    );
    Object.assign(env, { OTK_CONFIG: config, TMPDIR: Deno.env.get("TMPDIR")! });
    if (compiled) {
      Object.assign(env, {
        DENO_DIR: join(root, `empty-${index}`),
        DENO_NO_REMOTE: "1",
      });
    }
    const process = ownedProcess(
      compiled ? binary : Deno.execPath(),
      compiled ? [] : [
        "run",
        "--allow-net",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-sys=systemMemoryInfo",
        join(source, "main.ts"),
      ],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    process.child.stdout!.on("data", (chunk) => log += chunk.toString());
    process.child.stderr!.on("data", (chunk) => log += chunk.toString());
    await waitFor(async () => (await fetch(url + "/api/health")).ok, Boolean);
    const client = new WsClient(url);
    await client.connect();
    return {
      client,
      stop: async () => {
        await client.close();
        await process.stop();
        await Deno.writeTextFile(join(root, `runtime-${index}.log`), log);
        assertEquals(
          /Download|Module not found|Cannot find/.test(log),
          false,
          log,
        );
      },
    };
  };
  const identity = (client: WsClient): RequestRef => {
    const welcome = client.frames.find((frame) => frame.t === "welcome");
    assert(welcome?.t === "welcome");
    return {
      id: crypto.randomUUID(),
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      window: welcome.requests.window.id,
    };
  };
  const terminal = async (client: WsClient, ref: RequestRef) => {
    const event = await client.wait((event) =>
      event.t === "request.result" && event.ref.key === ref.key
    ) as Extract<RequestEvent, { t: "request.result" }>;
    assert(event.outcome.ok, JSON.stringify(event));
    const lifecycle = client.frames.filter((frame) =>
      "ref" in frame && frame.ref.key === ref.key
    );
    assertEquals(lifecycle[0].t, "request.accepted");
    return event.outcome.result;
  };
  let active: Awaited<ReturnType<typeof run>> | undefined;
  try {
    active = await run();
    const ref = identity(active.client),
      params = { directory: f.oc.directory, name: "perf", sessions: [] };
    active.client.send({ t: "request", ref, method: "tasks.create", params });
    const original = await terminal(active.client, ref) as TaskRecord;
    // Intentionally omit request.received and discard the first consumer.
    await active.stop();
    active = await run();
    active.client.send({
      t: "request",
      ref: { ...ref, id: crypto.randomUUID() },
      method: "tasks.create",
      params,
    });
    assertEquals(await terminal(active.client, ref), original);
    assertEquals(await active.client.rpc("tasks.list", {}), [original]);
    const nativeRef = identity(active.client);
    const nativeParams = {
      directory: f.oc.directory,
      title: "Lost native create receipt",
    };
    active.client.send({
      t: "request",
      ref: nativeRef,
      method: "session.create",
      params: nativeParams,
    });
    await remoteCommitted.promise;
    assertEquals(creates, 1);
    assertEquals(
      (await f.oc.request<{ id: string }>(`/session/${lostNativeID}`)).id,
      lostNativeID,
    );
    assertEquals(
      active.client.frames.some((frame) =>
        frame.t === "request.result" && frame.ref.key === nativeRef.key
      ),
      false,
    );
    // Only the test-owned OTK process is replaced; stock opencode stays alive.
    await active.stop();
    deliver.resolve();
    active = await run();
    active.client.send({
      t: "request",
      ref: { ...nativeRef, id: crypto.randomUUID() },
      method: "session.create",
      params: nativeParams,
    });
    await active.client.wait((frame) =>
      frame.t === "request.progress" && frame.ref.key === nativeRef.key &&
      frame.progress.code === "checking-outcome"
    );
    assertEquals(creates, 1);
    assertEquals(
      active.client.frames.some((frame) =>
        frame.t === "request.result" && frame.ref.key === nativeRef.key
      ),
      false,
    );
    assertEquals(await active.client.rpc("tasks.list", {}), [original]);
    const sessions = await f.oc.request<{ id: string }[]>("/session");
    assertEquals(
      sessions.filter((session) => session.id === lostNativeID).length,
      1,
    );
    await Deno.writeTextFile(
      join(root, "request-restart-proof.json"),
      JSON.stringify(
        {
          compiled,
          generations: generation,
          original,
          creates,
          lostNativeID,
          localRef: ref,
          nativeRef,
          events: active.client.frames.filter((frame) => "ref" in frame),
        },
        null,
        2,
      ),
    );
    await active.stop();
    active = undefined;
    const db = new DatabaseSync(join(state, "otk.db"), { readOnly: true });
    try {
      const local = db.prepare(
        "SELECT state,receipt_json FROM request_receipts WHERE intent_key=?",
      ).get(ref.key)!;
      const native = db.prepare(
        "SELECT state,dispatched_at,receipt_json FROM request_receipts WHERE intent_key=?",
      ).get(nativeRef.key)!;
      assertEquals(local.state, "succeeded");
      assertEquals(JSON.parse(String(local.receipt_json)), original);
      assertEquals(native.state, "reconciling");
      assert(native.dispatched_at !== null);
      assertEquals(native.receipt_json, null);
    } finally {
      db.close();
    }
  } finally {
    deliver.resolve();
    await active?.stop();
    await f.stop();
    await proxy.shutdown();
  }
}
