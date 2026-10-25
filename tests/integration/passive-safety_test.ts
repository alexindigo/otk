// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { HistoryEntry } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { serve } from "../support/http.ts";
import { nativeVersion } from "../support/native.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { test } from "../support/resources.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

test("passive sidecar reports the native version, leaves approvals manual and reads live WAL without database writes", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const requests: { method: string; path: string }[] = [];
  const controller = new AbortController();
  const proxy = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) => {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname });
      return fetch(new URL(url.pathname + url.search, oc.url), {
        method: req.method,
        headers: req.headers,
        signal: controller.signal,
      });
    },
  );
  let sidecar: SidecarTest | undefined, client: WsClient | undefined;
  try {
    const root = await oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Manual permission" },
    });
    for (const parentID of [root.id, undefined]) {
      await oc.request("/session", {
        method: "POST",
        body: { title: "Default manual scope", parentID },
      });
    }
    const marker = join(oc.directory, "must-stay-manual.txt");
    fake.queue({
      tool: {
        name: "bash",
        input: {
          command: `printf approved > ${marker}`,
          description: "Manual",
        },
      },
    }, { chunks: ["Finished"] });
    await oc.request(`/session/${root.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Keep this permission manual" }] },
    });
    const pending = await waitFor(
      () => oc.request<{ id: string; sessionID: string }[]>("/permission"),
      (rows) => rows.some((row) => row.sessionID === root.id),
    );
    // The native writer stays open. The prompt must actually reside in live WAL.
    const files = [oc.db, oc.db + "-wal"];
    const before = await Promise.all(files.map((file) => Deno.readFile(file)));
    assert(before[1].length > 32, "Expected committed live WAL pages");
    const state = join(oc.root, "passive-otk-state");
    sidecar = await SidecarTest.start(oc, {
      state: { path: state },
      harness: { url: `http://127.0.0.1:${proxy.addr.port}`, db: oc.db },
    });
    const health = await waitFor(
      async () => (await fetch(sidecar!.url + "/api/health")).json(),
      (health) => health.harness.version === nativeVersion,
    );
    client = new WsClient(sidecar.url);
    await client.connect();
    await client.wait((frame) =>
      frame.t === "harness" && frame.state === "connected"
    );
    const welcome = await client.wait((frame) => frame.t === "welcome");
    assert(welcome.t === "welcome");
    assertEquals(welcome.sidecar.harness.version, nativeVersion);
    assertEquals(health.harness.version, nativeVersion);
    const approvals = await client.wait((frame) => frame.t === "approvals");
    assert(approvals.t === "approvals");
    assertEquals(approvals.approvals.enabled, []);
    const history = await client.rpc<HistoryEntry[]>("history.list", {});
    assert(
      history.some((entry) => entry.input === "Keep this permission manual"),
    );
    await client.close();
    client = undefined;
    await sidecar.stop();
    sidecar = undefined;
    assertEquals(await oc.request("/permission"), pending);
    assertEquals(await Deno.stat(marker).then(() => true, () => false), false);
    assertEquals(
      await Promise.all(files.map((file) => Deno.readFile(file))),
      before,
    );
    const allowed = new Set([
      "/global/health",
      "/global/event",
      "/experimental/session",
      "/session/status",
      "/permission",
      "/question",
    ]);
    assert(requests.length > 0);
    for (const request of requests) {
      assertEquals(request.method, "GET", JSON.stringify(request));
      assert(allowed.has(request.path), JSON.stringify(request));
    }
    assert((await Deno.stat(join(state, "otk.db"))).isFile);
    console.info("PASSIVE SAFETY", {
      version: nativeVersion,
      requests,
      state,
      walBytes: before[1].length,
      approvals: [],
    });
  } finally {
    await client?.close();
    await sidecar?.stop();
    controller.abort();
    await proxy.shutdown();
    await oc.stop();
    await fake.stop();
  }
});
