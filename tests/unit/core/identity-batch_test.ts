// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { identityReadCodec } from "@otk/harness";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import { resources } from "../../support/resources.ts";
import { waitFor } from "../../support/opencode.ts";
import { cfg } from "./support.ts";
import type { Harness } from "@otk/harness";
import { OtkDb } from "@otk/store";
import { RpcRegistry } from "../../../core/ws/registry.ts";
import { fixture } from "./support.ts";
import { test } from "../../support/resources.ts";

test("RPC identity validation batches once, rejects missing and never hydrates session bodies", async () => {
  const db = new OtkDb(await fixture(), []);
  const batches: string[][] = [];
  const backend = {
    core: {
      identities(ids: readonly string[]) {
        batches.push([...ids]);
        return Promise.resolve(
          ids.filter((id) => id !== "tstv1-missing").map((id) => ({
            id,
            directory: "/p",
          })),
        );
      },
      getSession() {
        throw new Error("Body lookup forbidden");
      },
    },
    capabilities: {},
  } as unknown as Harness;
  try {
    const rpc = new RpcRegistry(backend, db);
    assertEquals(await rpc.context.sessionDirectory("tstv1-a"), "/p");
    assertEquals(
      await rpc.context.sessionDirectories(["tstv1-a", "tstv1-b", "tstv1-a"]),
      { "tstv1-a": "/p", "tstv1-b": "/p" },
    );
    assertEquals(batches, [["tstv1-a"], ["tstv1-a", "tstv1-b"]]);
    await assertRejects(() =>
      rpc.context.sessionDirectories(["tstv1-a", "tstv1-missing"])
    );
  } finally {
    db.close();
  }
});

test("identity owner release cancels actual worker I/O and releases admission for the next read", async () => {
  const root = await fixture(), settings = cfg();
  let entered = 0, aborted = 0;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/global/health") return Response.json({ healthy: true });
      if (path === "/session/hold") {
        entered++;
        return new Promise<Response>((resolve) =>
          request.signal.addEventListener("abort", () => {
            aborted++;
            resolve(Response.json({}));
          }, { once: true })
        );
      }
      if (path === "/session/fresh") {
        return Response.json({
          id: "fresh",
          directory: "/fresh",
        });
      }
      throw new Error(`Unexpected request ${path}`);
    },
  );
  resources().defer("identity native fixture", () => server.shutdown());
  const bridge = new DigestBridge({
    statePath: root,
    provider: "opencode-v1",
    native: {
      harness: {
        ...settings.harness,
        url: `http://127.0.0.1:${server.addr.port}`,
        db: root + "/absent.db",
      },
      index: settings.index,
    },
    policy: settings.digest,
    reads: { "identity.batch": identityReadCodec },
    publish() {},
  });
  try {
    const pending = bridge.read("identity.batch", { ids: ["opcv1-hold"] }, {
      owner: "retired",
      priority: "user",
    });
    const rejected = assertRejects(() => pending, DOMException);
    await waitFor(() => entered, (n) => n === 1);
    bridge.release("retired");
    await rejected;
    await waitFor(() => aborted, (n) => n === 1);
    bridge.release("retired");
    assertEquals(
      await bridge.read("identity.batch", { ids: ["opcv1-fresh"] }, {
        owner: "current",
        priority: "user",
      }),
      [{ id: "opcv1-fresh", directory: "/fresh" }],
    );
    assertEquals(aborted, 1);
  } finally {
    await bridge.stop();
  }
});
