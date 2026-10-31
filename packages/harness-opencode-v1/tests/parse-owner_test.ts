// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { StreamBuffers } from "@otk/content";
import { ContentReplay } from "@otk/harness";
import { cfg } from "../../../tests/support/config.ts";
import { mapMessage, mapPart, mapSession, mapStreamingShell } from "../map.ts";
import { Client } from "../client.ts";
import { Messages } from "../messages.ts";
import { Transcript } from "../transcript.ts";
import type { RawPart, Session } from "../types.ts";

Deno.test("message part position cannot masquerade as permission state", () => {
  const info = {
    id: "message",
    sessionID: "s",
    role: "assistant" as const,
    agent: "build",
    time: { created: 1 },
  };
  const parts: RawPart[] = [
    {
      id: "text",
      sessionID: "s",
      messageID: "message",
      type: "text",
      text: "Before tool",
    },
    {
      id: "tool",
      sessionID: "s",
      messageID: "message",
      type: "tool",
      tool: "bash",
      callID: "call",
      state: { status: "running", input: { command: "true" } },
    },
  ];
  const mapped = mapMessage(info, parts);
  const tool = mapped.parts[1];
  assert(tool.kind === "tool");
  assertEquals(tool.call.awaitingPermission, false);
  const arities: number[] = [];
  mapMessage(info, parts, undefined, (...args: [RawPart]) => {
    arities.push(args.length);
    return mapPart(args[0]);
  });
  assertEquals(arities, [1, 1]);
});

Deno.test("native active pages borrow event checkpoints before parsing their HTTP text", async () => {
  const config = cfg(), id = "opcv1-s";
  const raw: RawPart = {
    id: "part",
    messageID: "message",
    sessionID: "s",
    type: "text",
    text: "# Event-owned\n\nExact source",
    time: { start: 2 },
  };
  const session: Session = {
    id: "s",
    directory: "/project",
    projectID: "global",
    title: "Parser",
    time: { created: 1, updated: 2 },
  };
  const buffers = new StreamBuffers(),
    replay = new ContentReplay({
      ...config.messages,
      nonce: () => crypto.randomUUID(),
      emit() {},
    });
  buffers.epoch(id, replay.clock(id).epoch);
  buffers.subscriptions(id, 1);
  buffers.upsert(id, raw.messageID, mapStreamingShell(raw), raw.text!);
  const parsed = buffers.snapshot(raw.id)!.part.blocks;
  let textReads = 0;
  const fetched = {
    ...raw,
    get text() {
      textReads++;
      return raw.text;
    },
  };
  const reader = new Messages(
    new Client(
      config.harness,
      () => Promise.reject(new Error("Unexpected native read")),
    ),
    () => session.directory,
  );
  reader.page = () =>
    Promise.resolve({
      items: [{
        info: {
          id: "message",
          sessionID: "s",
          role: "assistant",
          agent: "build",
          time: { created: 2 },
        },
        parts: [fetched],
      }],
    });
  const transcript = new Transcript({
    buffers,
    replay,
    reader,
    raw: () => Promise.resolve(session),
    info: () => Promise.resolve(mapSession(session)),
    metadata: () => Promise.resolve({ boundaries: [] }),
    decorate: (message) => message,
    summaries: () => ({}),
  });
  try {
    const page = await transcript.page(id);
    const part = page.items[0].parts[0];
    assert(part.kind === "text");
    assertStrictEquals(part.blocks, parsed);
    assertEquals(
      textReads,
      0,
      "HTTP source is not read and parsed before replacement by the event checkpoint",
    );
    const reasoning = {
      ...raw,
      type: "reasoning",
      metadata: { title: "Thinking" },
      get text() {
        textReads++;
        return raw.text;
      },
    };
    assertEquals(mapStreamingShell(reasoning), {
      kind: "reasoning",
      id: "part",
      blocks: [],
      time: { start: 2, end: undefined },
      title: "Thinking",
    });
    assertEquals(
      textReads,
      0,
      "raw streaming shells never read discarded bodies",
    );
    mapPart(reasoning);
    assertEquals(textReads, 1, "settled historical parts read source once");
  } finally {
    transcript.release();
    buffers.stop();
  }
});
