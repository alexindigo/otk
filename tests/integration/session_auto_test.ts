// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { PermissionActivityPage, PermissionRequest } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import { FreezeProxy } from "../support/freeze-proxy.ts";

Deno.test("U9 stock session auto-approve executes bash and helpers with every OTK connection closed, survives restart and off restores waiting", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  const proxy = new FreezeProxy(oc.port);
  const state = join(oc.root, "auto-sidecar-state");
  const options = {
    state: { path: state },
    harness: { url: `http://127.0.0.1:${proxy.port}`, db: oc.db },
  };
  let server: SidecarTest | undefined, client: WsClient | undefined;
  const connect = async () => {
    const c = new WsClient(server!.url);
    await c.connect();
    await c.wait((frame) =>
      frame.t === "harness" && frame.state === "connected"
    );
    return c;
  };
  const create = (title: string) =>
    oc.request<{ id: string }>("/session", { method: "POST", body: { title } });
  const prompt = (id: string, text: string) =>
    oc.request(`/session/${id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text }] },
    });
  const bash = (name: string) => ({
    tool: {
      name: "bash",
      input: {
        command: `printf ${name} > ${name}.txt; printf ${name}`,
        description: name,
      },
    },
  });
  const outcome = async (id: string, name: string) => {
    await waitFor(
      () => Deno.readTextFile(join(oc.directory, `${name}.txt`)),
      (text) => text === name,
      60_000,
    );
    const messages = await waitFor(
      () =>
        oc.request<
          {
            parts: {
              type: string;
              state?: { status: string; output?: string };
            }[];
          }[]
        >(`/session/${id}/message`),
      (rows) =>
        rows.some((row) =>
          row.parts.some((part) =>
            part.type === "tool" && part.state?.status === "completed" &&
            part.state.output === name
          )
        ),
      60_000,
    );
    assert(messages.length > 0);
    await waitFor(
      () => oc.request<Record<string, unknown>>("/session/status"),
      (value) => !value[id],
      60_000,
    );
  };
  try {
    server = await SidecarTest.start(oc, options);
    client = await connect();
    const root = await create("Unattended session"),
      other = await create("Unrelated session");
    const initial = await client.wait((frame) => frame.t === "approvals");
    assert(initial.t === "approvals");
    assertEquals(initial.approvals.enabled, []);
    await client.rpc("permission.auto", { sessionID: root.id, enabled: true });
    await client.close();
    client = undefined;
    // No browser is ever launched, and no OTK WebSocket/content subscription remains.
    fake.queue(bash("root-auto"), { chunks: ["Root finished"] });
    await prompt(root.id, "Run the unattended root command");
    await outcome(root.id, "root-auto");
    fake.queue(
      {
        tool: {
          name: "task",
          input: {
            subagent_type: "general",
            description: "Unattended helper",
            prompt: "Run the scripted helper command",
          },
        },
      },
      bash("child-auto"),
      { chunks: ["Helper finished"] },
      { chunks: ["Parent finished"] },
    );
    await prompt(root.id, "Delegate the unattended helper command");
    const children = await waitFor(
      () => oc.request<{ id: string }[]>(`/session/${root.id}/children`),
      (rows) => rows.length > 0,
      60_000,
    );
    await outcome(children[0].id, "child-auto");
    await waitFor(
      () => oc.request<Record<string, unknown>>("/session/status"),
      (value) => !value[root.id],
      60_000,
    );
    fake.queue(bash("unrelated-waits"), { chunks: ["Unrelated rejected"] });
    await prompt(other.id, "This unrelated request must wait");
    const unrelated = await waitFor(
      () => oc.request<PermissionRequest[]>("/permission"),
      (rows) => rows.some((row) => row.sessionID === other.id),
      60_000,
    );
    assertEquals(
      await Deno.stat(join(oc.directory, "unrelated-waits.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
    client = await connect();
    const request = unrelated.find((row) => row.sessionID === other.id)!;
    await client.rpc("permission.reply", {
      sessionID: other.id,
      requestID: request.id,
      reply: "reject",
      message: "Unrelated scope stays manual",
    });
    await waitFor(
      () => oc.request<Record<string, unknown>>("/session/status"),
      (value) => !value[other.id],
      60_000,
    );
    await client.close();
    client = undefined;
    await server.stop();
    server = undefined;
    fake.queue(bash("restart-auto"), { chunks: ["Restart finished"] });
    await prompt(root.id, "Wait for the restarted sidecar");
    await waitFor(
      () => oc.request<PermissionRequest[]>("/permission"),
      (rows) => rows.some((row) => row.sessionID === root.id),
      60_000,
    );
    assertEquals(
      await Deno.stat(join(oc.directory, "restart-auto.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
    server = await SidecarTest.start(oc, options);
    await outcome(root.id, "restart-auto");
    client = await connect();
    const restored = await client.wait((frame) => frame.t === "approvals");
    assert(restored.t === "approvals");
    assertEquals(restored.approvals.enabled, [root.id]);
    await assertRejects(
      () =>
        client!.rpc("permission.auto", {
          sessionID: children[0].id,
          enabled: true,
        }),
      Error,
      "helper",
    );
    const activity = await waitFor(
      () =>
        client!.rpc<PermissionActivityPage>("permission.activity", {
          sessionID: root.id,
        }),
      (page) =>
        page.entries.filter((row) =>
          row.source === "auto" && row.outcome === "confirmed"
        ).length === 3,
    );
    assertEquals(
      new Set(activity.entries.map((row) => row.request.id)).size,
      3,
    );
    assert(
      activity.entries.some((row) => row.request.sessionID === children[0].id),
    );
    assert(
      activity.entries.every((row) =>
        row.reply === "once" && row.owner === root.id
      ),
    );
    const otherActivity = await client.rpc<PermissionActivityPage>(
      "permission.activity",
      { sessionID: other.id },
    );
    assertEquals(
      otherActivity.entries.map((row) => [row.source, row.reply, row.message]),
      [["manual", "reject", "Unrelated scope stays manual"]],
    );
    const disconnectedAt = client.frames.length;
    proxy.freeze();
    await waitFor(
      () => client!.frames.slice(disconnectedAt),
      (frames) =>
        frames.some((frame) =>
          frame.t === "harness" && frame.state !== "connected"
        ),
      60_000,
    );
    await client.rpc("permission.auto", { sessionID: root.id, enabled: false });
    const offlineActivity = await client.rpc<PermissionActivityPage>(
      "permission.activity",
      { sessionID: root.id },
    );
    assertEquals(
      offlineActivity.entries.map((row) => row.request.id),
      activity.entries.map((row) => row.request.id),
      "Stored activity stays readable while the native server is offline",
    );
    await client.close();
    client = undefined;
    proxy.thaw();
    fake.queue(bash("off-waits"), {
      chunks: ["Off request manually accepted"],
    });
    await prompt(root.id, "Off must wait for a new manual permission");
    const waiting = await waitFor(
      () => oc.request<PermissionRequest[]>("/permission"),
      (rows) => rows.some((row) => row.sessionID === root.id),
      60_000,
    );
    assertEquals(
      await Deno.stat(join(oc.directory, "off-waits.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );
    client = await connect();
    await client.rpc("permission.reply", {
      sessionID: root.id,
      requestID: waiting.find((row) => row.sessionID === root.id)!.id,
      reply: "once",
    });
    await outcome(root.id, "off-waits");
    const deleted = await create("Delete explicit auto policy");
    await client.rpc("permission.auto", {
      sessionID: deleted.id,
      enabled: true,
    });
    const deletionAt = client.frames.length;
    await oc.request(`/session/${deleted.id}`, { method: "DELETE" });
    await waitFor(
      () => client!.frames.slice(deletionAt),
      (frames) =>
        frames.some((frame) =>
          frame.t === "index.patch" &&
          frame.ops.some((op) => op.op === "remove" && op.id === deleted.id)
        ) &&
        frames.some((frame) =>
          frame.t === "approvals" &&
          !frame.approvals.enabled.includes(deleted.id)
        ),
    );
    await client.close();
    client = undefined;
    await server.stop();
    server = undefined;
    server = await SidecarTest.start(oc, options);
    client = await connect();
    const afterDeletion = await client.wait((frame) => frame.t === "approvals");
    assert(afterDeletion.t === "approvals");
    assertEquals(
      afterDeletion.approvals.enabled,
      [],
      "Deleted policy stays absent after sidecar restart",
    );
    console.info("U9 no-browser stock evidence", {
      root: root.id,
      child: children[0].id,
      state,
      autoReplies: activity.entries.length,
      allConnectionsClosedDuringAutomaticWork: true,
    });
  } finally {
    await client?.close();
    await server?.stop();
    await proxy.stop();
    await oc.stop();
    await fake.stop();
  }
});
