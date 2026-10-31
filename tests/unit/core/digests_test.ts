// SPDX-License-Identifier: LGPL-3.0-only
import { fixturePage } from "../../support/message-pages.ts";
import { assertEquals, assertRejects } from "@std/assert";
import type { Harness } from "@otk/harness";
import { OtkDb } from "@otk/store";
import { registerDigests } from "../../../core/features/digests.ts";
import {
  type RequestLifetime,
  RpcRegistry,
} from "../../../core/ws/registry.ts";
import { tempDir, test } from "../../support/resources.ts";

test("visible scopes are validated, optional, connection-owned replacements and release only their own socket", async () => {
  const db = new OtkDb(await tempDir("digest-scope-"), []);
  const scopes: unknown[] = [], released: string[] = [];
  const backend: Harness = {
    core: {
      kind: "external",
      version: "1",
      start: async () => {},
      stop: async () => {},
      subscriptions() {},
      identities: () => Promise.resolve([]),
      getSession: () =>
        Promise.reject(new Error("Scope must not hydrate a session")),
      createSession: () => Promise.reject(new Error("Not used")),
      listChildren: () => Promise.resolve([]),
      listMessages: (id) => Promise.resolve(fixturePage(id)),
    },
    capabilities: {
      digests: {
        scope: (owner, value) => scopes.push([owner, value]),
        release: (owner) => {
          released.push(owner);
        },
      },
    },
  };
  const rpc = new RpcRegistry(backend, db);
  registerDigests(rpc, backend);
  const one = new AbortController(), two = new AbortController();
  const first: (() => void)[] = [], second: (() => void)[] = [];
  const lifetime = (
    id: string,
    control: AbortController,
    callbacks: (() => void)[],
  ): RequestLifetime => ({
    id,
    signal: control.signal,
    defer: (release) => {
      callbacks.push(release);
    },
  });
  const a = lifetime("one", one, first), b = lifetime("two", two, second);
  try {
    const absent = new RpcRegistry({ ...backend, capabilities: {} }, db);
    registerDigests(absent, { ...backend, capabilities: {} });
    assertEquals(absent.methods(), []);
    await assertRejects(
      () => rpc.dispatch("digests.scope", { sessions: [] }),
      Error,
      "connection lifetime",
    );
    for (
      const params of [
        { directory: "   ", sessions: [] },
        { directory: "x".repeat(4097), sessions: [] },
        { directory: "/p\0bad", sessions: [] },
        { sessions: ["ses_bare"] },
        { sessions: ["tstv1-one", "tstv1-one"] },
      ]
    ) await assertRejects(() => rpc.dispatch("digests.scope", params, a));
    assertEquals(scopes, []);
    assertEquals(
      await rpc.dispatch("digests.scope", {
        directory: "/p",
        sessions: ["tstv1-one"],
      }, a),
      null,
    );
    await rpc.dispatch("digests.scope", { sessions: [] }, a);
    await rpc.dispatch("digests.scope", { directory: "/q", sessions: [] }, b);
    assertEquals(first.length, 1);
    assertEquals(second.length, 1);
    assertEquals(scopes, [
      ["one", { directory: "/p", sessions: ["tstv1-one"] }],
      ["one", { directory: undefined, sessions: [] }],
      ["two", { directory: "/q", sessions: [] }],
    ]);
    one.abort();
    first[0]();
    assertEquals(released, ["one"]);
    await assertRejects(() =>
      rpc.dispatch("digests.scope", { sessions: [] }, a)
    );
    two.abort();
    second[0]();
    assertEquals(released, ["one", "two"]);
  } finally {
    db.close();
  }
});
