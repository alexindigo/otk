// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { identityReadCodec } from "@otk/harness";
import { assertIdentityFields } from "../support/identity-assertions.ts";
import { DigestNativeDb } from "@otk/harness-opencode-v1";
import type { TaskRecord } from "@otk/protocol";
import { DigestBridge } from "../../core/digest/bridge.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import { cfg } from "../support/config.ts";
import { tempDir } from "../support/resources.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests(
  "V1 DigestNativeDb keyed identity SQL and native absence shapes",
  [
    "tests/integration/v2-index_test.ts#OC2I1",
    "tests/integration/v2-index_test.ts#OC2I4",
  ],
);

test("stock native batch identity consumer, task grouping, tombstone seen and unavailable authority", async () => {
  const oc = await OpencodeTest.start(new FakeLlm());
  const parent = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { title: "Identity parent" },
  });
  const child = await oc.session<{ id: string }>("/session", {
    method: "POST",
    body: { parentID: parent.id, title: "Identity child" },
  });
  const settings = cfg();
  const native = {
    harness: { ...settings.harness, url: oc.url, db: oc.db },
    index: settings.index,
    attachments: settings.attachments,
  };
  const bridge = new DigestBridge({
    statePath: await tempDir("identity-port-"),
    provider: "opencode-v1",
    native,
    policy: { ...settings.digest, publishrows: 1 },
    reads: { "identity.batch": identityReadCodec },
    publish() {},
  });
  const sql = new DigestNativeDb(oc.db);
  try {
    const columns = sql.db.prepare("PRAGMA table_info(session)").all().map((
      r,
    ) => r.name);
    assertEquals(columns.includes("parent_id"), true);
    const expected = [{ id: parent.id, directory: oc.directory }, {
      id: child.id,
      directory: oc.directory,
      parentID: parent.id,
    }].sort((a, b) => a.id.localeCompare(b.id));
    assertIdentityFields(sql.identities([parent.id, child.id]), expected);
    assertIdentityFields(
      await bridge.read("identity.batch", {
        ids: [parent.id, child.id, "opcv1-ses_missing"],
      }, { owner: "proof", priority: "user" }),
      expected,
    );
    const cancelled = new AbortController();
    cancelled.abort(new DOMException("Released", "AbortError"));
    await assertRejects(() =>
      bridge.read("identity.batch", { ids: [parent.id] }, {
        owner: "cancelled",
        priority: "user",
        signal: cancelled.signal,
      })
    );
  } finally {
    sql.close();
    await bridge.stop();
  }
  const sidecar = await SidecarTest.start(oc),
    client = new WsClient(sidecar.url);
  client.lease({
    directory: oc.directory,
    selected: parent.id,
    crumbs: [],
    rows: [child.id],
  });
  try {
    await client.connect();
    const task = await client.rpc<TaskRecord>("tasks.create", {
      directory: oc.directory,
      name: "Identity grouping",
      sessions: [parent.id, child.id],
    });
    assertEquals(task.sessions, [parent.id, child.id]);
    await waitFor(() => client.entry(child.id), Boolean);
    await oc.request(`/session/${child.id}`, { method: "DELETE" });
    await waitFor(() => client.entry(child.id)?.deleted, Boolean);
    await client.rpc("sessions.seen", { sessionID: child.id, terminal: 0 });
    assertEquals(
      (await client.rpc<TaskRecord[]>("tasks.list", {}))[0].sessions,
      [parent.id, child.id],
    );
    await client.rpc("tasks.removeSession", {
      id: task.id,
      sessionID: child.id,
    });
    assertEquals(
      (await client.rpc<TaskRecord[]>("tasks.list", {}))[0].sessions,
      [parent.id],
    );
    await oc.stop();
    const welcome = client.frames.findLast((frame) => frame.t === "welcome")!;
    if (welcome.t !== "welcome") throw new Error("Missing welcome");
    const ref = {
      clientID: crypto.randomUUID(),
      key: crypto.randomUUID(),
      id: crypto.randomUUID(),
      window: welcome.requests.window.id,
    };
    client.send({
      t: "request",
      ref,
      method: "tasks.addSession",
      params: { id: task.id, sessionID: parent.id },
    });
    await client.wait((frame) =>
      frame.t === "request.progress" && frame.ref.key === ref.key &&
      frame.progress.code === "backend-unavailable"
    );
    assertEquals(
      client.frames.some((frame) =>
        frame.t === "request.result" && frame.ref.key === ref.key
      ),
      false,
    );
    assertEquals(
      (await client.rpc<TaskRecord[]>("tasks.list", {}))[0].sessions,
      [parent.id],
    );
  } finally {
    await client.close();
    await sidecar.stop();
  }
});
