// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import type { QuestionRequest } from "@otk/protocol";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";
import { waitFor } from "../support/opencode.ts";
test("question snapshot, originating descendant events, reply and rejection use only the root family", async () => {
  const f = await browserFixture();
  let rootClient: WsClient | undefined, otherClient: WsClient | undefined;
  try {
    const root = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Root" },
      }),
      child = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Child", parentID: root.id },
      }),
      other = await f.oc.request<{ id: string }>("/session", {
        method: "POST",
        body: { title: "Other" },
      });
    const server = await f.sidecar();
    rootClient = new WsClient(server.url);
    otherClient = new WsClient(server.url);
    await rootClient.connect();
    await otherClient.connect();
    await rootClient.wait((frame) =>
      frame.t === "harness" && frame.state === "connected"
    );
    rootClient.send({ t: "subscribe", sessionID: root.id });
    otherClient.send({ t: "subscribe", sessionID: other.id });
    f.fake.queue({
      tool: {
        name: "question",
        input: {
          questions: [{
            header: "Child choice",
            question: "Choose",
            options: [{ label: "Yes", description: "Proceed" }],
            multiple: false,
          }],
        },
      },
    }, { chunks: ["Child answer recorded."] });
    await f.oc.request(`/session/${child.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Ask child question" }] },
    });
    await rootClient.wait((frame) =>
      frame.t === "content" && frame.sessionID === child.id &&
      frame.event.op === "question.upsert"
    );
    const pending = await rootClient.rpc<QuestionRequest[]>("question.list", {
      sessionID: root.id,
    });
    assertEquals(pending.length, 1);
    assertEquals(pending[0].sessionID, child.id);
    assertEquals(pending[0].questions[0].text, "Choose");
    assertEquals(pending[0].questions[0].custom, true);
    assert(!("tool" in pending[0]));
    assert(!("question" in pending[0].questions[0]));
    assertEquals(
      otherClient.frames.filter((frame) =>
        frame.t === "content" && frame.event.op.startsWith("question.")
      ).length,
      0,
    );
    await rootClient.rpc("question.reply", {
      requestID: pending[0].id,
      answers: [["Yes"]],
    });
    await rootClient.wait((frame) =>
      frame.t === "content" && frame.event.op === "question.remove" &&
      frame.event.requestID === pending[0].id
    );
    await waitFor(
      () =>
        f.oc.request<
          { parts: { type: string; state?: { status: string } }[] }[]
        >(`/session/${child.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.parts.some((part) =>
            part.type === "tool" && part.state?.status === "completed"
          )
        ),
    );
    assertEquals(
      await rootClient.rpc("question.list", { sessionID: root.id }),
      [],
    );
  } finally {
    await rootClient?.close();
    await otherClient?.close();
    await f.stop();
  }
});
