// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import type { ContentSession, PermissionRequest } from "@otk/protocol";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
test("I13 permission list and originating child events reach parent subscribers only", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  let server: SidecarTest | undefined,
    rootClient: WsClient | undefined,
    otherClient: WsClient | undefined;
  try {
    server = await SidecarTest.start(oc);
    rootClient = new WsClient(server.url);
    otherClient = new WsClient(server.url);
    await rootClient.connect();
    await otherClient.connect();
    await rootClient.wait((f) => f.t === "harness" && f.state === "connected");
    const root = await rootClient.rpc<ContentSession>("session.create", {
      directory: oc.directory,
      title: "Parent permissions",
    });
    const other = await rootClient.rpc<ContentSession>("session.create", {
      directory: oc.directory,
      title: "Unrelated root",
    });
    rootClient.send({ t: "subscribe", sessionID: root.id });
    otherClient.send({ t: "subscribe", sessionID: other.id });
    fake.queue(
      {
        tool: {
          name: "task",
          input: {
            subagent_type: "general",
            description: "OTK child permission probe",
            prompt: "Run the scripted bash probe",
          },
        },
      },
      {
        tool: {
          name: "bash",
          input: { command: "echo otk", description: "child probe" },
        },
      },
      { chunks: ["Child completed"] },
      { chunks: ["Parent completed"] },
    );
    await rootClient.rpc("session.prompt", {
      sessionID: root.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Delegate the probe" }],
    });
    const children = await waitFor(
      () => oc.request<{ id: string }[]>(`/session/${root.id}/children`),
      (children) => children.length > 0,
      60_000,
    );
    const child = children[0];
    const pending = await waitFor(
      () =>
        rootClient!.rpc<PermissionRequest[]>("permission.list", {
          sessionID: root.id,
        }),
      (requests) => requests.some((request) => request.sessionID === child.id),
      60_000,
    );
    const request = pending.find((request) => request.sessionID === child.id)!;
    assertEquals(request.detail, { kind: "bash", command: "echo otk" });
    assertEquals(request.alwaysPatterns, ["echo *"]);
    assert(!JSON.stringify(request).includes('"metadata"'));
    assertEquals(
      await rootClient.rpc("permission.list", { sessionID: other.id }),
      [],
    );
    const event = await rootClient.wait(
      (f) =>
        f.t === "content" && f.sessionID === child.id &&
        f.event.op === "permission.upsert",
      60_000,
    );
    assert(event.t === "content" && event.event.op === "permission.upsert");
    assertEquals(event.event.request.id, request.id);
    await rootClient.rpc("permission.reply", {
      sessionID: child.id,
      requestID: request.id,
      reply: "once",
    });
    await rootClient.wait((f) =>
      f.t === "content" && f.sessionID === child.id &&
      f.event.op === "permission.remove" && f.event.requestID === request.id
    );
    assertEquals(
      await rootClient.rpc("permission.list", { sessionID: root.id }),
      [],
    );
    assert(!otherClient.frames.some((f) => f.t === "content"));
    assert(
      !rootClient.frames.some((f) =>
        f.t === "content" && f.sessionID === child.id &&
        !f.event.op.startsWith("permission.")
      ),
      "Child message content was forwarded to the parent",
    );
  } finally {
    await rootClient?.close();
    await otherClient?.close();
    await server?.stop();
    await oc.stop();
    await fake.stop();
  }
});
