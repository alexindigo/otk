// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { ascendingID, type MessagePage } from "@otk/protocol";
import { nativeVersion } from "../support/provider-cache.ts";
import { nativeFixture } from "../support/native-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { bounded } from "../support/resources.ts";
import { test } from "../support/resources.ts";
import { WsClient } from "../support/ws-client.ts";

test("@messages @composer withdraw an unstarted prompt, preserve started prompts, and recognize shells", async () => {
  const f = await nativeFixture();
  const ws = new WsClient((await f.sidecar()).url);
  try {
    const session = await f.oc.createSession("Stop delivery");
    const sessionID = session.id;
    await ws.connect();
    const send = (text: string) =>
      ws.rpc<{ messageID: string }>("session.prompt", {
        sessionID,
        mode: "normal",
        parts: [{ kind: "text", text }],
      });
    const withdraw = (messageID: string) =>
      ws.rpc("session.withdraw", { sessionID, messageID });
    f.fake.queueHeld({ chunks: ["Held for Stop"] });
    const first = await send("First prompt");
    await waitFor(() => f.fake.active, (n) => n > 0);
    const second = await send("Waiting prompt");
    // Stop interrupts immediately; V2 intentionally parks its pending input.
    if (nativeVersion.startsWith("1.")) {
      await waitFor(
        () => f.oc.readMessages(sessionID),
        (v) => JSON.stringify(v).includes(second.messageID),
      );
    } else await ws.rpc("session.abort", { sessionID });
    assertEquals(await withdraw(second.messageID), { state: "withdrawn" });
    assert(
      !JSON.stringify(await f.oc.readMessages(sessionID)).includes(
        second.messageID,
      ),
    );
    await waitFor(() => f.fake.active, (n) => n === 0);
    assertEquals(await withdraw(first.messageID), { state: "started" });
    assertEquals(await withdraw(ascendingID("msg")), { state: "absent" });
    const shell = await ws.rpc<{ state: string }>("session.shell", {
      sessionID,
      command: "printf stop-delivery",
    });
    assertEquals(shell.state, "started");
  } finally {
    await ws.close();
    await f.stop();
  }
});

if (nativeVersion.startsWith("1.")) {
  test("@messages @composer V1 withdraw waits for native persistence instead of declaring an admitted prompt absent", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const hook = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async () => {
        entered.resolve();
        await release.promise;
        return new Response(null, { status: 204 });
      },
    );
    let f: Awaited<ReturnType<typeof nativeFixture>> | undefined;
    let ws: WsClient | undefined;
    try {
      f = await nativeFixture({}, {
        env: { OPENCODE_PURE: "0" },
        async prepare(native) {
          const plugins = `${native.directory}/.opencode/plugins`;
          await Deno.mkdir(plugins, { recursive: true });
          await Deno.writeTextFile(
            `${plugins}/stop-contract.js`,
            `export const StopContract = async () => ({
            "chat.message": async () => { await fetch("http://127.0.0.1:${hook.addr.port}"); },
          });`,
          );
        },
      });
      const { id: sessionID } = await f.oc.createSession(
        "Withdraw before native persistence",
      );
      ws = new WsClient((await f.sidecar()).url);
      await ws.connect();
      const messageID = ascendingID("msg");
      const submitted = ws.rpc("session.prompt", {
        sessionID,
        messageID,
        mode: "normal",
        parts: [{ kind: "text", text: "Still preparing" }],
      });
      await submitted;
      await bounded("native preparation hook", entered.promise, 5000);
      assert(
        !JSON.stringify(await f.oc.readMessages(sessionID)).includes(messageID),
      );
      const stopping = ws.rpc<{ state: string }>("session.withdraw", {
        sessionID,
        messageID,
      });
      const result = await stopping;
      assertEquals(result.state, "unconfirmed");
    } finally {
      release.resolve();
      await hook.shutdown();
      await ws?.close();
      await f?.stop();
    }
  });
}

test("@messages @composer accepted busy-session send correlates one prompt through auto-approved tool work and final prose", async () => {
  const f = await nativeFixture({ bash: "ask" });
  let ws: WsClient | undefined;
  try {
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Delivery contract" },
    });
    const app = await f.sidecar();
    ws = new WsClient(app.url);
    ws.lease({
      directory: f.oc.directory,
      selected: session.id,
      crumbs: [],
      rows: [],
    });
    await ws.connect();
    ws.send({ t: "subscribe", sessionID: session.id });
    await ws.rpc("session.messages", { sessionID: session.id });
    await ws.rpc("permission.auto", { sessionID: session.id, enabled: true });
    const held = f.fake.queueHeld({ chunks: ["First response stays active."] });
    await ws.rpc("session.prompt", {
      sessionID: session.id,
      mode: "normal",
      parts: [{ kind: "text", text: "First prompt" }],
    });
    await waitFor(() => f.fake.active, (n) => n > 0);
    f.fake.queue({
      tool: {
        name: "bash",
        input: {
          command: "printf 'delivery-permission'",
          description: "Delivery permission",
        },
      },
    }, { chunks: ["Final delivery prose."] });
    const receipt = await ws.rpc<{ messageID: string; state: string } | null>(
      "session.prompt",
      {
        sessionID: session.id,
        mode: "normal",
        parts: [{ kind: "text", text: "Queued correlated prompt" }],
      },
    );
    assert(
      receipt?.messageID,
      "Native acceptance must return its message identity",
    );
    assert(["accepted", "queued"].includes(receipt.state));
    held.release();
    const page = await waitFor(
      () => ws!.rpc<MessagePage>("session.messages", { sessionID: session.id }),
      (page) => JSON.stringify(page.items).includes("Final delivery prose."),
      60_000,
    );
    assertEquals(
      page.items.filter((m) => m.id === receipt.messageID).length,
      1,
    );
    const answers = page.items.filter((m) =>
      m.role === "assistant" && m.replyTo === receipt.messageID
    );
    assert(answers.length > 0, "The reply retains its causal prompt");
    assert(JSON.stringify(answers).includes("Final delivery prose."));
    await waitFor(
      () =>
        ws!.rpc<{ entries: { source: string; outcome: string }[] }>(
          "permission.activity",
          { sessionID: session.id },
        ),
      (activity) =>
        activity.entries.some((item) =>
          item.source === "auto" && item.outcome === "confirmed"
        ),
    );
  } finally {
    await ws?.close();
    await f.stop();
  }
});
