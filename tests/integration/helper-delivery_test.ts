// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { entityKey, type InboxBaseline } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { startNative } from "../support/native-fixture.ts";
import { nativeKind } from "../support/native.ts";
import { waitFor } from "../support/opencode.ts";
import { resources, withResources } from "../support/resources.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

Deno.test("parent-received foreground helper outcome retires unseen without opening either transcript", () =>
  withResources("helper delivery cold history", async () => {
    const fake = new FakeLlm(), v2 = nativeKind === "opencode-v2-server";
    fake.queue({
      tool: {
        name: v2 ? "subagent" : "task",
        input: {
          description: "Delivery proof",
          prompt: "Return the proof",
          ...(v2 ? { agent: "explore" } : { subagent_type: "general" }),
        },
      },
    });
    fake.queue({ chunks: ["Helper result received by parent."] });
    fake.queue({ chunks: ["Parent retained the helper result."] });
    const native = await startNative(fake),
      parent = await native.createSession("Delivery parent");
    await native.prompt(parent.id, "Delegate and summarize the result");
    const child = await waitFor(
      async () =>
        (await native.listSessions(20)).find((s) => s.id !== parent.id),
      Boolean,
    );
    assert(child);
    const app = await SidecarTest.start(native, { digest: { idlems: 60000 } }),
      ws = new WsClient(app.url);
    resources().defer("delivery socket", () => ws.close());
    ws.lease({
      directory: native.directory,
      crumbs: [],
      rows: [child.id, parent.id],
    });
    await ws.connect();
    const inbox = async () =>
      (await ws.rpc<InboxBaseline>("inbox.get", {})).inbox;
    const childKey = entityKey("session", child.id);
    const settled = await waitFor(
      inbox,
      (value) =>
        (value.entities?.[childKey]?.terminal ?? 0) > 0 &&
        value.entities?.[childKey]?.counts.unseen === 0,
      30000,
    );
    const entity = settled.entities![childKey];
    assertEquals(entity.state, "none");
    assertEquals(entity.outcome, "succeeded");
    assertEquals(settled.seen[child.id], undefined);
    // The helper's actual outcome history survives acknowledgement.
    assertEquals(
      settled.finishes[child.id],
      entity.terminal,
    );
    assertEquals(
      settled.entities?.[entityKey("session", parent.id)]?.counts.unseen,
      1,
    );
    await app.stop();
  }));
