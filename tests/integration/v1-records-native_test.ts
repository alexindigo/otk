// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { v1NativeTests } from "../support/native-contract.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";
import { resources } from "../support/resources.ts";
import {
  isRealPrompt,
  type MessagePage,
  type PermissionRequest,
  type QuestionRequest,
} from "@otk/protocol";
import {
  type Info,
  opencodeV1SessionID,
  type RawPart,
} from "@otk/harness-opencode-v1";
type NativeMessage = { info: Info; parts: RawPart[] };
const test = v1NativeTests(
  "V1 record mapping and plugin-owned retained native outcomes",
  ["tests/integration/v2-transcripts_test.ts#OC2T4"],
);

/** Scoped native-producer diagnostics; no product or shared fixture hooks. */
async function nativeProbe(native: OpencodeTest, fake: FakeLlm, name: string) {
  const directory =
    `${Deno.cwd()}/.test-state/do/nt4-diagnostics/${name}-${native.port}`;
  await Deno.mkdir(directory, { recursive: true });
  fake.recordRequests(`${directory}/provider-requests.json`);
  const events: {
    type: string;
    properties: { sessionID?: string; status?: { type?: string } };
  }[] = [];
  const source = new EventSource(
    `${native.url}/event?directory=${encodeURIComponent(native.directory)}`,
  );
  resources().defer("NT4 native diagnostic events", () => source.close());
  source.onmessage = (event) => {
    const value = JSON.parse(event.data);
    if (value.type === "session.status" || value.type === "session.idle") {
      events.push(value);
      Deno.writeTextFileSync(
        `${directory}/native-status.jsonl`,
        JSON.stringify(value) + "\n",
        { append: true },
      );
    }
  };
  await waitFor(() => source.readyState, (state) => state === EventSource.OPEN);
  const observe = async (
    label: string,
    sessionID: string,
    outcome?: unknown,
  ) => {
    const status = await native.request("/session/status");
    const messages = await native.request(
      `/session/${sessionID}/message?limit=10`,
    );
    const offered = fake.requests.map((request) => ({
      tools: Array.isArray(request.tools)
        ? request.tools.map((tool) =>
          (tool as { function?: { name?: string } }).function?.name
        )
        : [],
      stream: request.stream,
    }));
    await Deno.writeTextFile(
      `${directory}/observations.jsonl`,
      JSON.stringify({
        label,
        status,
        events,
        messages,
        offered,
        outcome,
        queue: fake.pending,
        active: fake.active,
      }) + "\n",
      { append: true },
    );
  };
  const trace = async (
    label: string,
    sessionID: string,
    run: () => Promise<unknown>,
  ) => {
    try {
      const result = await run();
      await observe(`${label}:settled`, sessionID, result);
      return result;
    } catch (error) {
      await observe(`${label}:rejected`, sessionID, String(error));
      throw error;
    }
  };
  const idleSince = async (mark: number, sessionID: string) => {
    const nativeID = opencodeV1SessionID.decode(sessionID);
    await waitFor(
      () => events.slice(mark),
      (values) =>
        values.some((event) =>
          event.properties.sessionID === nativeID &&
          (event.type === "session.idle" ||
            event.properties.status?.type === "idle")
        ),
    );
    await observe("native idle witnessed", sessionID);
  };
  return { observe, trace, mark: () => events.length, idleSince };
}

test("OC1R1 stock V1 synthetic-only and mixed records keep visible parts and truthful prompt anchors", async () => {
  const fake = new FakeLlm(), native = await OpencodeTest.start(fake);
  const target = await native.createSession("NT4 native records");
  const probe = await nativeProbe(native, fake, "abort");
  const server = await SidecarTest.start(native);
  const client = new WsClient(server.url);
  try {
    await client.connect();
    client.send({ t: "subscribe", sessionID: target.id });
    const read = () =>
      client.rpc<MessagePage>("session.messages", { sessionID: target.id });
    const synthetic = await native.request<NativeMessage>(
      `/session/${target.id}/message`,
      {
        method: "POST",
        body: {
          noReply: true,
          parts: [{
            type: "text",
            synthetic: true,
            text: "Native expansion, not a user prompt",
          }],
        },
      },
    );
    const first = await waitFor(
      read,
      (page) => page.items.some((row) => row.id === synthetic.info.id),
    );
    assertEquals(
      first.items.find((row) => row.id === synthetic.info.id)?.role,
      "context",
    );
    assertEquals(first.prompt, undefined);
    const mixed = await native.request<NativeMessage>(
      `/session/${target.id}/message`,
      {
        method: "POST",
        body: {
          noReply: true,
          parts: [{ type: "text", text: "Real user prompt" }, {
            type: "text",
            synthetic: true,
            text: "Added context belongs to that prompt",
          }],
        },
      },
    );
    const page = await waitFor(
      read,
      (page) => page.prompt?.id === mixed.info.id,
    );
    const message = page.items.find((row) => row.id === mixed.info.id)!;
    assert(isRealPrompt(message));
    assertEquals(
      message.parts.map((part) => part.id),
      mixed.parts.map((part) => part.id),
    );
    assert(
      message.parts.some((part) =>
        part.kind === "external" && part.activity?.direction === "outgoing"
      ),
    );
    const live = client.frames.filter((frame) =>
      frame.t === "content" && frame.event.op === "message.upsert"
    );
    assert(
      live.some((frame) =>
        frame.t === "content" && frame.event.op === "message.upsert" &&
        frame.event.message.id === synthetic.info.id &&
        frame.event.message.role === "context"
      ),
    );
    const compactionMark = probe.mark();
    fake.queue({
      chunks: ["# Native compaction summary\n\n**Retained summary**"],
    });
    await probe.trace(
      "summarize",
      target.id,
      () =>
        native.request(`/session/${target.id}/summarize`, {
          method: "POST",
          body: { providerID: "fake", modelID: "scripted" },
        }),
    );
    const compacted = await waitFor(
      read,
      (page) =>
        page.items.some((row) =>
          row.parts.some((part) =>
            part.kind === "external" &&
            part.name === "opencode-v1/compaction-summary"
          )
        ),
    );
    assert(
      compacted.items.flatMap((row) => row.parts).some((part) =>
        part.kind === "external" && part.activity?.category === "compaction"
      ),
    );
    await probe.idleSince(compactionMark, target.id);
    assertEquals(
      fake.pending,
      0,
      "manual compaction consumes its one summary script",
    );
    await probe.observe("before abort prompt", target.id);
    const abortMark = probe.mark();
    const held = fake.queueHeld({ chunks: ["Start abort fixture"] });
    const running = probe.trace(
      "abort prompt",
      target.id,
      () => native.prompt(target.id, "Start the abort fixture"),
    );
    await waitFor(() => fake.active, (count) => count > 0);
    await native.interrupt(target.id);
    held.release();
    await running;
    await probe.idleSince(abortMark, target.id);
    const aborted = await waitFor(
      read,
      (page) =>
        page.items.some((row) =>
          row.parts.some((part) =>
            part.kind === "external" && part.activity?.title === "Interrupted"
          )
        ),
    );
    assert(
      aborted.items.some((row) => row.role === "assistant" && row.interrupted),
    );
  } finally {
    await probe.observe("abort fixture final", target.id);
    await client.close();
    await server.stop();
    await native.stop();
    await fake.stop();
  }
});

test("OC1R2 stock V1 failed task and independent parent provider failure both retain exact errors", async () => {
  const fake = new FakeLlm(), error = "The usage limit has been reached";
  let calls = 0;
  const failure = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const body = await request.text();
      if (body && JSON.parse(body).stream && ++calls > 1) {
        return Response.json({
          error: {
            message: error,
            type: "invalid_request_error",
            code: "usage_limit",
          },
        }, { status: 400 });
      }
      return await fetch(
        `http://127.0.0.1:${fake.port}${new URL(request.url).pathname}`,
        {
          method: request.method,
          headers: request.headers,
          body: body || undefined,
        },
      );
    },
  );
  const native = await OpencodeTest.start(fake, {
    task: "allow",
    bash: "allow",
  }, {
    config: {
      provider: {
        limited: {
          npm: "@ai-sdk/openai-compatible",
          options: {
            baseURL: `http://127.0.0.1:${
              (failure.addr as Deno.NetAddr).port
            }/v1`,
            apiKey: "fixture",
          },
          models: { scripted: { name: "scripted" } },
        },
      },
    },
  });
  const target = await native.createSession("NT4 independent failures");
  const server = await SidecarTest.start(native);
  const client = new WsClient(server.url);
  try {
    await client.connect();
    client.send({ t: "subscribe", sessionID: target.id });
    await client.rpc("session.messages", { sessionID: target.id });
    fake.queue({
      tool: {
        name: "task",
        input: {
          subagent_type: "general",
          description: "Inspect provider failure",
          prompt: "Attempt this task",
        },
      },
    });
    await native.request(`/session/${target.id}/message`, {
      method: "POST",
      body: {
        model: { providerID: "limited", modelID: "scripted" },
        parts: [{ type: "text", text: "Delegate and report" }],
      },
    });
    const page = await waitFor(
      () =>
        client.rpc<MessagePage>("session.messages", { sessionID: target.id }),
      (page) =>
        page.items.some((row) =>
          row.role === "assistant" && row.error?.message.includes(error)
        ),
    );
    assert(
      page.items.flatMap((row) => row.parts).some((part) =>
        part.kind === "tool" && part.call.tool === "task" &&
        part.call.error?.includes(error)
      ),
    );
    assert(
      page.items.some((row) =>
        row.role === "assistant" && row.error?.message.includes(error)
      ),
    );
  } finally {
    await client.close();
    await server.stop();
    await native.stop();
    await failure.shutdown();
    await fake.stop();
  }
});

test("OC1R3 requests settled outside OTK survive an OTK restart as independent V1 transcript records", async () => {
  const fake = new FakeLlm(),
    native = await OpencodeTest.start(fake, undefined, {
      env: { OPENCODE_CLIENT: "cli" },
    });
  const target = await native.createSession("NT4 retained requests");
  const probe = await nativeProbe(native, fake, "requests");
  const state = { path: `${native.root}/retained-state` };
  let server = await SidecarTest.start(native, { state });
  let client = new WsClient(server.url);
  try {
    await client.connect();
    client.send({ t: "subscribe", sessionID: target.id });
    await client.rpc("session.messages", { sessionID: target.id });
    const permissionMark = probe.mark();
    fake.queue({
      tool: {
        name: "bash",
        input: { command: "printf nt4", description: "Permission fixture" },
      },
    });
    const permissionRun = probe.trace(
      "permission prompt",
      target.id,
      () =>
        native.prompt(
          target.id,
          "Run the permission fixture",
        ),
    );
    const permissions = await waitFor(
      () => native.request<PermissionRequest[]>("/permission"),
      (rows) => rows.length > 0,
    );
    await native.replyPermission(target.id, permissions[0].id, "reject");
    await permissionRun;
    await probe.idleSince(permissionMark, target.id);
    assertEquals(
      fake.pending,
      0,
      "permission continuation script must be consumed before the question prompt",
    );
    await probe.observe("before question prompt", target.id);
    fake.queue({
      tool: {
        name: "question",
        input: {
          questions: [{
            header: "Choice",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue" }],
          }],
        },
      },
    }, { chunks: ["Question settled"] });
    const questionRun = probe.trace(
      "question prompt",
      target.id,
      () => native.prompt(target.id, "Ask the question fixture"),
    );
    const questions = await waitFor(
      () => native.request<QuestionRequest[]>("/question"),
      (rows) => rows.length > 0,
    );
    await native.request(`/question/${questions[0].id}/reject`, {
      method: "POST",
    });
    await questionRun;
    const read = () =>
      client.rpc<MessagePage>("session.messages", { sessionID: target.id });
    const before = await waitFor(
      read,
      (page) =>
        page.items.some((row) => row.id === `question:${questions[0].id}`),
    );
    assert(
      before.items.some((row) => row.id === `permission:${permissions[0].id}`),
    );
    await client.close();
    await server.stop();
    server = await SidecarTest.start(native, { state });
    client = new WsClient(server.url);
    await client.connect();
    const after = await client.rpc<MessagePage>("session.messages", {
      sessionID: target.id,
    });
    assert(
      after.items.some((row) =>
        row.id === `permission:${permissions[0].id}` && row.role === "context"
      ),
    );
    assert(
      after.items.some((row) =>
        row.id === `question:${questions[0].id}` && row.role === "context"
      ),
    );
  } finally {
    await probe.observe("request fixture final", target.id);
    await client.close();
    await server.stop();
    await native.stop();
    await fake.stop();
  }
});

test("OC1R4 stock V1 retry action remains historical after interruption and OTK restart", async () => {
  const fake = new FakeLlm(), native = await OpencodeTest.start(fake);
  const target = await native.createSession("NT4 retained retry");
  const state = { path: `${native.root}/retry-state` };
  let server = await SidecarTest.start(native, { state });
  let client = new WsClient(server.url);
  try {
    await client.connect();
    client.send({ t: "subscribe", sessionID: target.id });
    await client.rpc("session.messages", { sessionID: target.id });
    fake.failRemaining("FreeUsageLimitError", 429);
    const running = native.prompt(target.id, "Exercise the retry action");
    const status = await waitFor(
      () =>
        native.request<
          Record<
            string,
            {
              type: string;
              attempt?: number;
              next?: number;
              action?: Record<string, string>;
            }
          >
        >("/session/status"),
      (rows) => rows[target.nativeID]?.type === "retry",
    );
    assertEquals(status[target.nativeID].action?.reason, "free_tier_limit");
    const before = await waitFor(
      () =>
        client.rpc<MessagePage>("session.messages", { sessionID: target.id }),
      (page) => page.items.some((row) => row.id.startsWith("retry:")),
    );
    const record = before.items.find((row) => row.id.startsWith("retry:"))!;
    const part = record.parts[0];
    assert(part.kind === "external");
    assertEquals(part.activity?.state?.facts, {
      active: false,
      terminal: true,
    });
    assert(JSON.stringify(record).includes("https://opencode.ai/go"));
    await native.interrupt(target.id);
    await running;
    await client.close();
    await server.stop();
    server = await SidecarTest.start(native, { state });
    client = new WsClient(server.url);
    await client.connect();
    const after = await client.rpc<MessagePage>("session.messages", {
      sessionID: target.id,
    });
    assertEquals(after.items.find((row) => row.id === record.id), record);
    assertEquals(
      JSON.parse(record.source!.payload!).data.action,
      status[target.nativeID].action,
    );
    assert(
      part.activity?.body?.some((block) =>
        block.b === "paragraph" &&
        block.inline.some((inline) =>
          inline.i === "link" &&
          inline.href === status[target.nativeID].action!.link
        )
      ),
    );
  } finally {
    await client.close();
    await server.stop();
    await native.stop();
    await fake.stop();
  }
});

test("OC1R5 request metadata first observed in the native inventory survives settlement and restart", async () => {
  const fake = new FakeLlm(),
    native = await OpencodeTest.start(fake, undefined, {
      env: { OPENCODE_CLIENT: "cli" },
    });
  const target = await native.createSession("NT4 pending before OTK");
  const state = { path: `${native.root}/inventory-state` };
  const question = "Keep this question text from the startup inventory";
  let server: SidecarTest | undefined, client: WsClient | undefined;
  try {
    fake.queue({
      tool: {
        name: "question",
        input: {
          questions: [{
            header: "Startup",
            question,
            options: [{ label: "Yes", description: "Proceed" }],
          }],
        },
      },
    });
    const running = native.prompt(target.id, "Ask before OTK starts");
    const pending = await waitFor(
      () => native.request<QuestionRequest[]>("/question"),
      (rows) => rows.length > 0,
    );
    server = await SidecarTest.start(native, { state });
    client = new WsClient(server.url);
    await client.connect();
    const observed = await client.rpc<QuestionRequest[]>("question.list", {
      sessionID: target.id,
    });
    assert(JSON.stringify(observed).includes(question));
    await native.request(`/question/${pending[0].id}/reject`, {
      method: "POST",
    });
    await running;
    const recordID = `question:${pending[0].id}`;
    const before = await waitFor(
      () =>
        client!.rpc<MessagePage>("session.messages", { sessionID: target.id }),
      (page) => page.items.some((row) => row.id === recordID),
    );
    const record = before.items.find((row) => row.id === recordID)!;
    assert(
      record.source!.payload!.includes(question),
      "startup request facts must remain with their independent outcome",
    );
    await client.close();
    await server.stop();
    server = await SidecarTest.start(native, { state });
    client = new WsClient(server.url);
    await client.connect();
    const after = await client.rpc<MessagePage>("session.messages", {
      sessionID: target.id,
    });
    assertEquals(after.items.find((row) => row.id === recordID), record);
  } finally {
    await client?.close();
    await server?.stop();
    await native.stop();
    await fake.stop();
  }
});
