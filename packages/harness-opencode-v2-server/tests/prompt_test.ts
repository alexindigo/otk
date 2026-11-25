// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import {
  type OperationContext,
  OperationFailure,
  type ReceiptData,
} from "@otk/protocol";
import { V2Client } from "../client.ts";
import { preparePrompt, V2Prompt } from "../prompt.ts";
import { selectAction, sessionActions } from "../session-actions.ts";
import type { NativeSession } from "../messages.ts";
function fixture(variant = "default") {
  const calls: {
      path: string;
      body: Record<string, unknown> | undefined;
      fenced: number;
    }[] = [],
    receipts: ReceiptData[] = [];
  let fence = 0,
    agent = "build",
    model = { providerID: "fake", id: "scripted", variant },
    fail = "";
  const submissions: { sessionID: string; messageID: string }[] = [];
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
    key: {
      clientID: "fixture",
      key: "prompt",
      window: "test",
      origin: "composer",
    },
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
        if (/\/message$/.test(path)) {
          return Promise.resolve(Response.json({ data: [], cursor: {} }));
        }
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
      if (path.endsWith("/compact")) {
        return Promise.resolve(Response.json({
          data: {
            id: "msg_0123456789abcdefghij",
            sessionID: "ses_root",
            time: { created: 1 },
            type: "compaction",
            payload: {},
            delivery: "steer",
          },
        }));
      }
      return Promise.resolve(
        path.endsWith("/prompt")
          ? Response.json({ data: {} })
          : new Response(null, { status: 204 }),
      );
    },
  );
  return {
    prompt: new V2Prompt(
      () => client,
      undefined,
      undefined,
      (sessionID, messageID) => {
        submissions.push({ sessionID, messageID });
        return Promise.resolve();
      },
    ),
    submissions,
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
  assertEquals(f.submissions.length, 1);
  assertEquals(f.submissions[0].sessionID, input.sessionID);
  assertEquals(f.calls.at(-1)?.body, {
    id: f.submissions[0].messageID,
    text: "  exact text\n",
  });
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
Deno.test("V2 fallback submits and returns ascending native-format identities", async () => {
  const f = fixture(), ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const receipt = await f.prompt.prompt({
      sessionID: "opcv2-ses_root",
      mode: "normal",
      parts: [{ kind: "text", text: "Native-compatible fallback" }],
    }, f.operation);
    const id = f.calls.at(-1)!.body!.id as string;
    assertMatch(id, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    assertEquals(receipt, { messageID: id, state: "queued" });
    assertEquals(f.submissions.at(-1)!.messageID, id);
    ids.push(id);
  }
  assert(ids[1] > ids[0]);
  assert(ids[2] > ids[1]);
});
Deno.test("V2 successful prompt returns the exact submitted native identity", async () => {
  const f = fixture();
  const receipt: unknown = await f.prompt.prompt({
    sessionID: "opcv2-ses_root",
    messageID: "msg_123456789abcdef01234567890",
    mode: "normal",
    parts: [{ kind: "text", text: "Correlate this send" }],
  }, f.operation);
  assertEquals(receipt, {
    messageID: "msg_123456789abcdef01234567890",
    state: "queued",
  });
  assertEquals(f.submissions[0].messageID, "msg_123456789abcdef01234567890");
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

Deno.test("V2 prompt and action keep the applied variant and switch only on an explicit change (2.62)", async () => {
  const applied = { provider: "fake", model: "scripted" };
  for (
    const [variant, expected] of [
      ["high", undefined],
      ["low", { providerID: "fake", id: "scripted", variant: "low" }],
    ] as const
  ) {
    for (const action of [false, true]) {
      const f = fixture("high");
      const input = { agent: "build", model: applied, variant };
      if (action) {
        await selectAction(
          f.client,
          {
            id: "ses_root",
            agent: "build",
            location: { directory: "/repo" },
            model: { providerID: "fake", id: "scripted", variant: "high" },
          } as NativeSession,
          input,
          f.operation,
        );
      } else {
        await f.prompt.prompt({
          ...input,
          sessionID: "opcv2-ses_root",
          mode: "normal",
          parts: [{ kind: "text", text: "keep the applied variant" }],
        }, f.operation);
      }
      assertEquals(
        f.calls.find((c) => c.path.endsWith("/model"))?.body,
        expected && { model: expected },
        `${variant} ${action ? "action" : "prompt"}`,
      );
    }
  }
});

Deno.test("V2 compaction never switches the applied model or variant (2.62)", async () => {
  const f = fixture("high");
  const { sessionActions: actions } = sessionActions({
    client: () => f.client,
    observed() {},
    removed: () => Promise.resolve(),
  });
  await actions!.compact("opcv2-ses_root", {
    provider: "fake",
    model: "scripted",
  });
  assert(f.calls.some((c) => c.path.endsWith("/compact")));
  assertEquals(
    f.calls.filter((c) =>
      c.path.endsWith("/model") || c.path.endsWith("/agent")
    ),
    [],
  );
});
