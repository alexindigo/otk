// SPDX-License-Identifier: LGPL-3.0-only
import { type BrowserContext, expect, test } from "@playwright/test";
import { runInNewContext } from "node:vm";
import type {
  IntentIdentity,
  LoadCoverage,
  Message,
  MessagePage,
  Part,
  ServerFrame,
} from "@otk/protocol";
import { observeTranscript } from "../fixtures/transcript-publication.ts";

test("harness.transcript-publication-one-body", {
  tag: "@harness",
}, async () => {
  const request: IntentIdentity = {
    clientID: "00000000-0000-0000-0000-000000000001",
    window: "00000000-0000-0000-0000-000000000002",
    key: "00000000-0000-0000-0000-000000000003",
  };
  const attempt = "00000000-0000-0000-0000-000000000004";
  const independent = {
    ...request,
    key: "00000000-0000-0000-0000-000000000005",
  };
  const sessionID = "ses_outside";
  const messageID = "msg_outside";
  const partID = "prt_outside";
  const callID = "call_outside";
  const path = "/outside/probe.txt";
  const marker = "outside marker";
  const header: Message = {
    id: messageID,
    sessionID,
    role: "assistant",
    agent: "build",
    model: { provider: "fixture", model: "scripted" },
    tokens: {
      input: null,
      output: null,
      reasoning: null,
      cache: { read: null, write: null },
    },
    cost: null,
    interrupted: false,
    time: { created: 1 },
    parts: [],
  };
  const running: Extract<Part, { kind: "tool" }> = {
    kind: "tool",
    id: partID,
    call: {
      tool: "read",
      callID,
      status: "running",
      path,
      loaded: [],
      time: {},
    },
  };
  const completed: Part = {
    ...running,
    call: { ...running.call, status: "completed", output: marker },
  };
  const clock = (seq: number) => ({ epoch: "content-epoch", seq });
  const body: MessagePage = {
    sessionID,
    version: { generation: 1, revision: 0 },
    clock: clock(107),
    from: clock(107),
    session: {
      id: sessionID,
      directory: "/project",
      title: "Outside read",
      projectID: "project",
      time: { created: 1, updated: 1 },
      archived: false,
    },
    items: [{ ...header, parts: [running] }],
    older: "older-page",
    catchup: [],
    turns: {},
    helpers: {},
    recovering: [],
  };
  const load: LoadCoverage = {
    id: request.key,
    scope: { kind: "session-messages", sessionID },
    boundary: { kind: "page", limit: 10 },
    generation: "1:0:content-epoch",
    revision: 1,
    state: "loading",
  };
  const olderID = "msg_older";
  const olderPart: Part = {
    kind: "text",
    id: "prt_older",
    blocks: [{ b: "paragraph", inline: [{ i: "text", text: "Older text" }] }],
    synthetic: false,
  };
  const olderLoad: LoadCoverage = {
    ...load,
    id: independent.key,
    boundary: { kind: "page", limit: 10, before: "older-page" },
  };
  const finish = (coverage: LoadCoverage): LoadCoverage => ({
    ...coverage,
    revision: 2,
    state: "complete",
  });
  // dry99 V1: header, atomic body at 107, completed read at 108, then
  // terminal coverage repeating the running body at 107. IDs are fixtures.
  const frames: ServerFrame[] = [
    {
      t: "content",
      sessionID,
      clock: clock(106),
      event: { op: "message.upsert", message: header },
    },
    {
      t: "load.chunk",
      request,
      epoch: 1,
      load,
      data: { kind: "message-page", page: body },
    },
    {
      t: "content",
      sessionID,
      clock: clock(108),
      event: { op: "part.upsert", messageID, part: completed },
    },
    {
      t: "request.result",
      ref: { ...request, id: attempt },
      seq: 3,
      outcome: { ok: true, result: { ...body, load: finish(load) } },
    },
    {
      t: "load.chunk",
      request: independent,
      epoch: 1,
      load: olderLoad,
      data: { kind: "message-page", page: null },
    },
    {
      t: "request.result",
      ref: { ...independent, id: "00000000-0000-0000-0000-000000000006" },
      seq: 3,
      outcome: {
        ok: true,
        result: {
          ...body,
          items: [{ ...header, id: olderID, parts: [olderPart] }],
          load: finish(olderLoad),
        },
      },
    },
  ];

  class Socket extends EventTarget {
    constructor(readonly url: string) {
      super();
    }
  }
  const globals = {
    WebSocket: Socket,
    URL,
    location: new URL("http://publication.test/"),
    transcriptPublication: new Map<string, Message>(),
  };
  // Exercise the actual init script as a standalone callback, just as
  // Playwright installs it. Only socket delivery is replaced.
  await observeTranscript({
    addInitScript(script: () => void) {
      runInNewContext(`(${script.toString()})()`, globals);
    },
  } as unknown as BrowserContext);
  const socket = new globals.WebSocket("ws://publication.test/prefix/api/ws");
  const readings = frames.map((frame) => {
    socket.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(frame),
      }),
    );
    const part = globals.transcriptPublication.get(messageID)?.parts.find(
      (part) =>
        part.id === partID && part.kind === "tool" &&
        part.call.callID === callID,
    );
    return part?.kind === "tool" && part.call.tool === "read"
      ? {
        status: part.call.status,
        path: part.call.path,
        output: part.call.output ?? null,
      }
      : null;
  });
  const exact = { status: "completed", path, output: marker };
  expect(readings.slice(0, 3)).toEqual([
    null,
    { status: "running", path, output: null },
    exact,
  ]);
  expect(readings[3], "terminal coverage must not replace the read")
    .toEqual(exact);
  expect(
    JSON.stringify(globals.transcriptPublication.get(olderID)?.parts),
    "independent unstreamed result publishes its body",
  ).toBe(JSON.stringify([olderPart]));
});
