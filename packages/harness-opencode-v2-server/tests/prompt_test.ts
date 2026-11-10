// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import {
  type OperationContext,
  OperationFailure,
  type ReceiptData,
} from "@otk/protocol";
import { V2Client } from "../client.ts";
import { preparePrompt, V2Prompt } from "../prompt.ts";
import { selectAction } from "../session-actions.ts";
import type { NativeSession } from "../messages.ts";
function fixture() {
  const calls: {
      path: string;
      body: Record<string, unknown> | undefined;
      fenced: number;
    }[] = [],
    receipts: ReceiptData[] = [];
  let fence = 0,
    agent = "build",
    model = { providerID: "fake", id: "scripted", variant: "default" },
    fail = "";
  const operation: OperationContext = {
    signal: new AbortController().signal,
    beforeEffect() {
      fence++;
      return Promise.resolve();
    },
    checkpoint(_kind: string, receipt: ReceiptData) {
      receipts.push(receipt);
      return Promise.resolve();
    },
    progress() {},
    key: { clientID: "fixture", key: "prompt", window: "test" },
  };
  const client = new V2Client(
    { endpoint: { url: "http://localhost:4000" }, pid: 1, version: "2.2.6" },
    1000,
    new AbortController().signal,
    (input, init) => {
      const path = new URL(String(input)).pathname,
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body, fenced: fence });
      if (path.endsWith(fail) && fail) {
        return Promise.reject(new TypeError("transport lost"));
      }
      if (init?.method === "GET") {
        if (path === "/api/agent") {
          return Promise.resolve(Response.json({
            data: [{
              id: "reviewer",
              model: { providerID: "fake", id: "scripted", variant: "high" },
            }],
          }));
        }
        return Promise.resolve(
          Response.json({
            data: {
              id: "ses_root",
              location: { directory: "/repo" },
              agent,
              model,
            },
          }),
        );
      }
      if (path.endsWith("/agent")) agent = body.agent;
      if (path.endsWith("/model")) model = body.model;
      return Promise.resolve(
        path.endsWith("/prompt")
          ? Response.json({ data: {} })
          : new Response(null, { status: 204 }),
      );
    },
  );
  return {
    prompt: new V2Prompt(() => client),
    client,
    calls,
    receipts,
    operation,
    fail: (path: string) => {
      fail = path;
    },
  };
}
Deno.test("V2 prepares then separately fences changed agent/model/variant and sends exact prompt without selection fields", async () => {
  const f = fixture();
  const input = {
    sessionID: "opcv2-ses_root",
    mode: "normal" as const,
    parts: [{ kind: "text" as const, text: "  exact text\n" }],
    agent: "plan",
    model: { provider: "fake", model: "scripted" },
    variant: "high",
  };
  await f.prompt.prompt(input, f.operation);
  assertEquals(f.calls.map((c) => c.path.split("/").at(-1)), [
    "ses_root",
    "agent",
    "model",
    "prompt",
  ]);
  assertEquals(f.calls.map((c) => c.fenced), [0, 1, 2, 3]);
  assertEquals(f.calls.at(-1)?.body, { text: "  exact text\n" });
  assertEquals(f.receipts.map((r) => r.kind), [
    "prompt-selection",
    "prompt-selection",
  ]);
  await f.prompt.prompt(input, f.operation);
  assertEquals(f.calls.slice(4).map((c) => c.path.split("/").at(-1)), [
    "ses_root",
    "prompt",
  ]);
  await f.prompt.prompt(
    { ...input, agent: "plan", variant: "low" },
    f.operation,
  );
  assertEquals(f.calls.slice(6).map((c) => c.path.split("/").at(-1)), [
    "ses_root",
    "model",
    "prompt",
  ]);
});
Deno.test("V2 prompt and action selections resolve the agent's model default before switching", async () => {
  for (const action of [false, true]) {
    const f = fixture();
    const input = {
      agent: "reviewer",
      model: { provider: "fake", model: "scripted" },
    };
    if (action) {
      await selectAction(
        f.client,
        {
          id: "ses_root",
          agent: "build",
          location: { directory: "/repo" },
          model: { providerID: "fake", id: "scripted", variant: "default" },
        } as NativeSession,
        input,
        f.operation,
      );
    } else {
      await f.prompt.prompt({
        ...input,
        sessionID: "opcv2-ses_root",
        mode: "normal",
        parts: [{ kind: "text", text: "applied high" }],
      }, f.operation);
    }
    assertEquals(f.calls.find((c) => c.path.endsWith("/model"))?.body, {
      model: { providerID: "fake", id: "scripted", variant: "high" },
    });
  }
});
Deno.test("V2 failed preparation leaves every selection untouched; uncertain later switch is never resent", async () => {
  const f = fixture();
  await assertRejects(
    () =>
      f.prompt.prompt({
        sessionID: "opcv2-ses_root",
        mode: "normal",
        parts: [{ kind: "file", source: "path", path: "/missing-v3-fixture" }],
        agent: "plan",
      }, f.operation),
    OperationFailure,
  );
  assertEquals(f.calls.length, 1);
  assertEquals(f.receipts, []);
  f.fail("/model");
  const failure = await assertRejects(
    () =>
      f.prompt.prompt({
        sessionID: "opcv2-ses_root",
        mode: "normal",
        parts: [{ kind: "text", text: "keep draft" }],
        agent: "plan",
        model: { provider: "fake", model: "other" },
      }, f.operation),
    OperationFailure,
  );
  assertEquals(failure.outcome, "unknown");
  assertEquals(f.calls.slice(1).map((c) => c.path.split("/").at(-1)), [
    "ses_root",
    "agent",
    "agent",
    "model",
  ]);
  assertEquals(f.receipts.length, 1);
});
Deno.test("V2 prepared upload and agent mentions preserve offsets and exact bytes", async () => {
  const result = await preparePrompt([{
    kind: "text",
    text: "@file and @agent",
  }, {
    kind: "file",
    source: "upload",
    name: "recall.txt",
    mime: "text/plain",
    dataBase64: "cmVjYWxsZWQgYnl0ZXM=",
    mention: { start: 0, end: 5, text: "@file" },
  }, {
    kind: "agent",
    name: "general",
    mention: { start: 10, end: 16, text: "@agent" },
  }], "/repo");
  assertEquals(result.files?.[0], {
    uri: "data:text/plain;base64,cmVjYWxsZWQgYnl0ZXM=",
    name: "recall.txt",
    source: { type: "inline" },
    mention: { start: 0, end: 5, text: "@file" },
  });
  assertEquals(result.agents?.[0].mention, {
    start: 10,
    end: 16,
    text: "@agent",
  });
  await assertRejects(
    () =>
      preparePrompt([{ kind: "text", text: "different" }, {
        kind: "agent",
        name: "general",
        mention: { start: 0, end: 6, text: "@agent" },
      }], "/repo"),
    OperationFailure,
  );
});
