// SPDX-License-Identifier: LGPL-3.0-only
import { derivedValue } from "@otk/protocol";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type NativeMessage,
  OpencodeV2ServerAdapter,
  opencodeV2SessionID as ids,
} from "@otk/harness-opencode-v2-server";
import type { ContentOp, Message, MessagePage } from "@otk/protocol";
import { createTranscriptProjection, timelinePrompts } from "@otk/client";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeV2Test } from "../support/opencode-v2.ts";
import { nativeKind } from "../support/native.ts";
import { resources, withResources } from "../support/resources.ts";
import { waitFor } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { WsClient } from "../support/ws-client.ts";

function body(messages: readonly Message[]): string {
  return JSON.stringify(
    messages.flatMap((m) =>
      m.parts.flatMap((p) =>
        p.kind === "text" || p.kind === "reasoning" ? [p.blocks] : []
      )
    ),
  );
}
function adapter(
  native: OpencodeV2Test,
  content: (id: string, op: ContentOp) => void = () => {},
) {
  const config = cfg(), errors: unknown[] = [];
  const value = new OpencodeV2ServerAdapter(
    {
      serviceFile: native.serviceFile,
      harness: config.harness,
      messages: config.messages,
    },
    undefined,
    (error) => errors.push(error),
  );
  resources().defer("V2 transcript adapter", () => value.core.stop());
  return {
    value,
    errors,
    start: () =>
      value.core.start({
        connection: () => {},
        indexReset: () => {},
        indexUpsert: () => {},
        indexRemove: () => {},
        bootstrapComplete: () => {},
        invalidate: () => {},
        content,
      }),
  };
}
async function completed(native: OpencodeV2Test, sid: string): Promise<void> {
  await waitFor(
    () => native.api.session.active(),
    (active) => !active[ids.decode(sid)],
    30000,
  );
}

Deno.test({
  name:
    "OC2T1 live text and reconnect preserve complete output through the neutral transcript consumer",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 live transcript", async () => {
      const fake = new FakeLlm();
      fake.queue({
        chunks: ["start ", "one ", "two ", "three ", "four ", "five ", "done"],
        delay: 350,
      });
      const native = await OpencodeV2Test.start(fake),
        target = await native.createSession(),
        projection = createTranscriptProjection();
      const a = adapter(native, (_id, op) => projection.apply(op));
      await a.start();
      a.value.core.subscriptions(target.id, 1);
      const page = await a.value.core.listMessages(target.id, {});
      projection.replace(page.items);
      await native.prompt(target.id, "live transcript fixture");
      await waitFor(() => body(projection.messages()), (text) =>
        text.includes("one"), 30000);
      native.proxy.disconnect();
      await completed(native, target.id);
      await waitFor(() =>
        body(projection.messages()), (value) =>
        value.includes("start one two three four five done"), 30000);
      const final = await a.value.core.listMessages(target.id, {});
      projection.replace(final.items);
      assert(
        body(projection.messages()).includes(
          "start one two three four five done",
        ),
      );
      assertEquals(timelinePrompts(projection.messages()).length, 1);
      const assistant = projection.messages().find((m) =>
        m.role === "assistant"
      );
      assert(assistant?.role === "assistant");
      assertEquals(assistant.replyTo, final.prompt?.id);
      assertEquals(
        a.errors.filter((e) =>
          String(e).includes("identity mismatch")
        ),
        [],
      );
    }),
});

Deno.test({
  name:
    "OC2T4 native reasoning, typed tool results, shell deltas and selection keep real-prompt identity",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 native part kinds", async () => {
      const fake = new FakeLlm();
      fake.queue({
        reasoning: ["check the file"],
        tool: { name: "read", input: { path: "note.txt" } },
      });
      fake.queue({ chunks: ["read complete"] });
      const native = await OpencodeV2Test.start(fake, {
          prepare: (fixture) =>
            Deno.writeTextFile(
              fixture.directory + "/note.txt",
              "first line\nsecond line\n",
            ),
        }),
        target = await native.createSession(),
        projection = createTranscriptProjection(),
        ops: ContentOp[] = [];
      const a = adapter(native, (_id, op) => {
        ops.push(op);
        projection.apply(op);
      });
      await a.start();
      a.value.core.subscriptions(target.id, 1);
      const initial = await a.value.core.listMessages(target.id, {});
      projection.replace(initial.items);
      await native.prompt(target.id, "read note.txt");
      await completed(native, target.id);
      await waitFor(
        () => projection.messages().flatMap((m) => m.parts),
        (parts) =>
          parts.some((p) =>
            p.kind === "tool" && p.call.tool === "read" &&
            p.call.status === "completed"
          ),
      );
      const snapshot = await a.value.core.listMessages(target.id, {});
      const part = snapshot.items.flatMap((m) => m.parts).find((p) =>
        p.kind === "tool" && p.call.tool === "read"
      );
      assert(part?.kind === "tool" && part.call.tool === "read");
      assertEquals(part.call.path, "note.txt");
      assertEquals(part.call.outputContent?.kind, "file");
      assertEquals(
        snapshot.items.flatMap((m) => m.parts).some((p) =>
          p.kind === "reasoning"
        ),
        true,
      );
      const shell = native.api.session.shell({
        sessionID: target.nativeID,
        command: "printf early; sleep 1.5; printf ' late'",
      });
      await waitFor(
        () => projection.messages().flatMap((m) => m.parts),
        (parts) =>
          parts.some((p) =>
            p.kind === "external" && p.activity?.kindLabel === "Shell result" &&
            p.activity.body?.some((b) => b.b === "code" && b.text === "early")
          ),
        10000,
      );
      await shell;
      await waitFor(
        () => projection.messages().flatMap((m) => m.parts),
        (parts) =>
          parts.some((p) =>
            p.kind === "external" && p.activity?.state?.key === "exited" &&
            p.activity.body?.some((b) =>
              b.b === "code" && b.text === "early late"
            )
          ),
        10000,
      );
      assertEquals(timelinePrompts(projection.messages()).length, 1);
      await native.api.session.switchAgent({
        sessionID: target.nativeID,
        agent: "plan",
      });
      await waitFor(() => ops, (events) =>
        events.some((e) =>
          e.op === "session.selection" && e.selection.agent === "plan"
        ));
      assertEquals(timelinePrompts(projection.messages()).length, 1);
      assertEquals(
        (await a.value.core.listMessages(target.id, {})).prompt?.agent,
        "plan",
      );
    }),
});

Deno.test({
  name:
    "OC2T2 fork chronology, ten-message cursor pages and staged cutoff follow native source order",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 transcript paging", async () => {
      const fake = new FakeLlm();
      const native = await OpencodeV2Test.start(fake),
        target = await native.createSession();
      for (let i = 0; i < 7; i++) {
        fake.queue({ chunks: [`reply-${i}`] });
        await native.prompt(target.id, `prompt-${i}`);
        await completed(native, target.id);
      }
      const fork = await native.api.session.fork({
          sessionID: target.nativeID,
        }),
        forkID = ids.encode(fork.id),
        a = adapter(native);
      await a.start();
      a.value.core.subscriptions(forkID, 1);
      let page = await a.value.core.listMessages(forkID, {});
      const first = page;
      const all: Message[] = [...page.items];
      let pages = 1;
      while (page.older) {
        page = await a.value.core.listMessages(forkID, { before: page.older });
        all.unshift(...page.items);
        pages++;
        assert(pages < 10);
      }
      assert(pages >= 2);
      assertEquals(timelinePrompts(all).length, 7);
      assertEquals(new Set(all.map((m) => m.id)).size, all.length);
      const projection = createTranscriptProjection();
      projection.replace([...all].reverse());
      assertEquals(projection.state.messageIDs, all.map((m) => m.id));
      const boundary = all.find((m) =>
        m.role === "user" && body([m]).includes("prompt-4")
      );
      assert(boundary);
      await native.api.session.revert.stage({
        sessionID: fork.id,
        messageID: boundary.id,
        files: false,
      });
      await waitFor(
        () => a.value.core.getSession(forkID),
        (s) => s.revert?.messageID === boundary.id,
      );
      const visible = await a.value.core.listMessages(forkID, {});
      assert(!body(visible.items).includes("prompt-4"));
      assert(!body(visible.items).includes("reply-6"));
      if (first.older) {
        await assertRejects(() =>
          a.value.core.listMessages(forkID, { before: first.older! })
        );
      }
    }),
});

Deno.test({
  name:
    "OC2T3 worker scalar reply usage survives body paging and compiled application acquisition",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 transcript usage", async () => {
      const fake = new FakeLlm();
      fake.queue({ chunks: ["charged reply"] });
      const native = await OpencodeV2Test.start(fake),
        target = await native.createSession();
      await native.prompt(target.id, "usage fixture");
      await completed(native, target.id);
      const app = await SidecarTest.start(native), ws = new WsClient(app.url);
      resources().defer("V2 usage socket", () => ws.close());
      await ws.connect();
      await ws.wait((f) => f.t === "welcome");
      const page = await ws.rpc<MessagePage>("session.messages", {
        sessionID: target.id,
      });
      assert(body(page.items).includes("charged reply"));
      assert(page.prompt);
      const usage = await ws.rpc<import("@otk/protocol").TurnUsageDetail>(
        "usage.get",
        { sessionID: target.id, turnID: page.prompt.id },
      );
      assertEquals(usage.calls.length, 1);
      assertEquals(usage.calls[0].turnID, page.prompt.id);
      assertEquals("parts" in usage.calls[0], false);
      assertEquals(usage.version, page.version);
      assertEquals(usage.calls[0].tokens.output !== null, true);
      const raw = await native.api.message.list({
        sessionID: target.nativeID,
        limit: 200,
        order: "desc",
      });
      const assistants = raw.data.filter((
        m,
      ): m is Extract<NativeMessage, { type: "assistant" }> =>
        m.type === "assistant"
      );
      assertEquals(usage.calls.map((c) => c.id), assistants.map((m) => m.id));
    }),
});
Deno.test({
  name: "OC2T5 scalar helper progress reaches the compiled page consumer",
  ignore: nativeKind !== "opencode-v2-server",
  fn: () =>
    withResources("V2 helper progress", async () => {
      const fake = new FakeLlm();
      fake.queue({
        tool: {
          name: "subagent",
          input: {
            description: "Inspect fixture",
            prompt: "Read note.txt and report",
            agent: "explore",
          },
        },
      });
      fake.queue({ tool: { name: "read", input: { path: "note.txt" } } });
      fake.queue({ chunks: ["child finished"] });
      fake.queue({ chunks: ["parent done"] });
      const native = await OpencodeV2Test.start(fake, {
          prepare: (fixture) =>
            Deno.writeTextFile(
              fixture.directory + "/note.txt",
              "helper fixture\n",
            ),
        }),
        parent = await native.createSession();
      await native.prompt(
        parent.id,
        "Ask an explore subagent to inspect note.txt",
      );
      await completed(native, parent.id);
      const rows = await native.api.message.list({
        sessionID: parent.nativeID,
        limit: 200,
        order: "desc",
      });
      const task = rows.data.flatMap((m) =>
        m.type === "assistant" ? m.content : []
      ).find((p) => p.type === "tool" && p.name === "subagent");
      assert(task?.type === "tool" && task.state.status === "completed");
      const childID = Reflect.get(task.state.metadata ?? {}, "sessionID");
      assert(typeof childID === "string");
      const child = ids.encode(childID);
      const app = await SidecarTest.start(native, {
          digest: { cpu: 1, retryms: 10 },
        }),
        ws = new WsClient(app.url);
      resources().defer("V2 helper socket", () => ws.close());
      ws.lease({
        directory: native.directory,
        selected: parent.id,
        crumbs: [],
        rows: [child],
      });
      await ws.connect();
      await ws.rpc<MessagePage>("session.messages", { sessionID: parent.id });
      await waitFor(() => ws.entry(child)?.digest.helper, (value) =>
        value?.state === "ready", 30000);
      const page = await ws.rpc<MessagePage>("session.messages", {
        sessionID: parent.id,
      });
      assertEquals(derivedValue(page.helpers[child]?.progress)?.toolCount, 1);
      const mapped = page.items.flatMap((m) =>
        m.parts
      ).find((p) =>
        p.kind === "tool" && p.call.tool === "task"
      );
      assert(mapped?.kind === "tool" && mapped.call.tool === "task");
      assertEquals(mapped.call.progress, page.helpers[child]);
    }),
});
