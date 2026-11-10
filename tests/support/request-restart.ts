// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { RequestEvent, RequestRef, TaskRecord } from "@otk/protocol";
import { nativeBehavior as nativeFixture } from "./native-testing.ts";
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
        request.method !== "POST" ||
        url.pathname !==
          (f.oc.kind === "opencode-v2-server" ? "/api/session" : "/session")
      ) return response;
      creates++;
      const bytes = await response.arrayBuffer();
      assert(response.ok);
      const body = JSON.parse(new TextDecoder().decode(bytes));
      lostNativeID = f.oc.kind === "opencode-v2-server"
        ? body.data.id
        : body.id;
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
  const discovery = join(root, "discovery");
  if (f.oc.kind === "opencode-v2-server") {
    await Deno.mkdir(join(discovery, "opencode"), { recursive: true });
    const registration = JSON.parse(await Deno.readTextFile(f.oc.serviceFile));
    await Deno.writeTextFile(
      join(discovery, "opencode/service.json"),
      JSON.stringify({
        ...registration,
        url: `http://127.0.0.1:${proxy.addr.port}`,
      }),
      { mode: 0o600 },
    );
  }
  await Deno.writeTextFile(
    config,
    `[server]\nport=${port}\n[auth]\ntype="none"\n[state]\npath=${
      JSON.stringify(state)
    }\n[harness]\ntype="${f.oc.kind}"\nurl="http://127.0.0.1:${proxy.addr.port}"\ndb=${
      JSON.stringify(f.oc.db)
    }\n[digest]\nretryms=10\ncpu=1\nmemoryreserve=1\n`,
  );
  let generation = 0;
  // Native discovery changes HOME, not the source runner's dependency cache.
  const cache = compiled ? undefined : await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (cache && !cache.success) {
    throw new Error(new TextDecoder().decode(cache.stderr));
  }
  const sourceCache = cache
    ? JSON.parse(new TextDecoder().decode(cache.stdout)).denoDir
    : undefined;
  const run = async () => {
    const index = ++generation;
    const env = Object.fromEntries(
      Object.entries(Deno.env.toObject()).filter(([key]) =>
        !key.startsWith("OTK_")
      ),
    );
    Object.assign(env, { OTK_CONFIG: config, TMPDIR: Deno.env.get("TMPDIR")! });
    if (sourceCache) env.DENO_DIR = sourceCache;
    if (f.oc.kind === "opencode-v2-server") {
      Object.assign(env, f.oc.discoveryEnv, { XDG_STATE_HOME: discovery });
    }
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
    client.lease({ directory: f.oc.directory, crumbs: [], rows: [] });
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
      (f.oc.kind === "opencode-v2-server"
        ? await f.oc.api.session.get({ sessionID: lostNativeID })
        : await f.oc.request<{ id: string }>(`/session/${lostNativeID}`)).id,
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
    const sessions = await f.oc.listSessions();
    assertEquals(
      sessions.filter((session) => session.nativeID === lostNativeID).length,
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
