// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";
import { createIndex } from "@otk/client";
import type { MessagePage } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { helperParent } from "../support/helper-parent.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";
test("real native helper summaries decorate pages, removals patch only progress and v2 metadata reopens", async () => {
  const fake = new FakeLlm(),
    oc = await OpencodeTest.start(fake, { bash: "allow" });
  let server: SidecarTest | undefined, client: WsClient | undefined;
  try {
    const { parent, child, work, tool } = await helperParent(oc);
    const path = join(oc.root, "helper-state");
    server = await SidecarTest.start(oc, {
      state: { path },
      digest: { cpu: 1, retryms: 10 },
    });
    client = new WsClient(server.url);
    client.lease({
      directory: oc.directory,
      selected: parent.id,
      crumbs: [],
      rows: [child.id],
    });
    await client.connect();
    await client.rpc("session.messages", { sessionID: parent.id });
    const index = createIndex();
    let cursor = 0;
    const entry = () => {
      for (const frame of client!.frames.slice(cursor)) {
        if (frame.t === "index.snapshot" || frame.t === "index.patch") {
          assert(index.receive("test", frame));
        }
      }
      cursor = client!.frames.length;
      return index.state.entries[`test/${child.id}`];
    };
    await waitFor(entry, (value) => value?.digest.helper?.state === "ready");
    assertEquals(entry().digest.helper?.toolCount, 1);
    const page = await client.rpc<MessagePage>("session.messages", {
      sessionID: parent.id,
    });
    assertEquals(page.items.length, 10);
    assertEquals(page.helpers[child.id].toolCount, 1);
    assertEquals(page.helpers[child.id].current?.name, "bash");
    assert(page.helpers[child.id].time?.end !== undefined);
    const tasks = page.items.flatMap((m) => m.parts).filter((p) =>
      p.kind === "tool" && p.call.tool === "task"
    );
    assert(tasks.length > 1);
    for (const part of tasks) {
      if (part.kind === "tool" && part.call.tool === "task") {
        assertEquals(part.call.progress, page.helpers[child.id]);
      }
    }
    await oc.request(
      `/session/${child.id}/message/${work.info.id}/part/${tool.id}`,
      { method: "DELETE" },
    );
    await waitFor(entry, (value) => value?.digest.helper?.toolCount === 0);
    assertEquals(entry().digest.helper?.current, undefined);
    await client.close();
    client = undefined;
    await server.stop();
    server = undefined;
    const db = new DatabaseSync(join(path, "digest.db"), { readOnly: true });
    try {
      assertEquals(
        db.prepare("SELECT tool_count FROM digest_helpers WHERE session_id=?")
          .get(child.id)?.tool_count,
        0,
      );
      assertEquals(
        db.prepare(
          "SELECT count(*) n FROM opcv1_helper_tools WHERE session_id=?",
        ).get(child.id)?.n,
        0,
      );
      assert(
        db.prepare("PRAGMA table_info(opcv1_messages)").all().some((row) =>
          row.name === "variant"
        ),
      );
    } finally {
      db.close();
    }
    server = await SidecarTest.start(oc, { state: { path } });
    client = new WsClient(server.url);
    client.lease({
      directory: oc.directory,
      selected: parent.id,
      crumbs: [],
      rows: [child.id],
    });
    await client.connect();
    await client.rpc("session.messages", { sessionID: parent.id });
    // Accept the first page before waiting for optional cached helper replay.
    await waitFor(
      () => client!.entry(child.id)?.digest.helper,
      (value) => value?.state === "ready",
    );
    const reloaded = await client.rpc<MessagePage>("session.messages", {
      sessionID: parent.id,
    });
    assertEquals(reloaded.helpers[child.id].toolCount, 0);
  } finally {
    await client?.close();
    await server?.stop();
    await oc.stop();
    await fake.stop();
  }
});
