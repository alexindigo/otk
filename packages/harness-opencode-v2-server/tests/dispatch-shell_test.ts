// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { ContentOp } from "@otk/protocol";
import { Transcript } from "../transcript.ts";
import { V2Client } from "../client.ts";
import type { NativeMessage } from "../messages.ts";
import { cfg } from "../../../tests/support/config.ts";

Deno.test("V2 missing shell identity is looked up once off dispatch without delaying the next native record", async () => {
  const lifetime = new AbortController(),
    release = Promise.withResolvers<void>();
  const client = new V2Client(
    { endpoint: { url: "http://fixture" }, version: "2.2.6", pid: 1 },
    1000,
    lifetime.signal,
  );
  const content: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => client,
    policy: cfg().messages,
    content: (_id, op) => content.push(op),
    diagnostic: (error) => {
      throw error;
    },
    invalidated() {},
    facts: () =>
      Promise.resolve({
        source: "fixture",
        contexts: { msg_shell: { order: 1 } },
        metadata: { boundaries: [] },
      }),
  });
  let reads = 0;
  transcript.reader.page = async () => {
    reads++;
    await release.promise;
    return {
      items: [
        {
          id: "msg_shell",
          type: "shell",
          shellID: "shell",
          command: "echo done",
          status: "exited",
          time: { created: 1, completed: 5 },
          output: { output: "done", cursor: 4, size: 4, truncated: false },
          exit: 0,
        } as NativeMessage,
      ],
    };
  };
  const id = "opcv2-ses_shell_dispatch";
  transcript.subscriptions(id, 1);
  try {
    const event = {
      type: "session.shell.ended",
      created: 5,
      data: {
        sessionID: "ses_shell_dispatch",
        shell: { id: "shell", command: "echo done", status: "exited" },
      },
    };
    const timeout = new AbortController();
    const gate = new Promise<never>((_resolve, reject) =>
      timeout.signal.addEventListener(
        "abort",
        () => reject(new Error("Shell lookup blocked dispatch")),
        { once: true },
      )
    );
    const timer = setTimeout(() => timeout.abort(), 1000);
    try {
      await Promise.race([transcript.event(event), gate]);
    } finally {
      clearTimeout(timer);
    }
    await transcript.event(event);
    await transcript.event({
      id: "evt_next",
      type: "session.synthetic",
      created: 6,
      data: { sessionID: "ses_shell_dispatch", text: "Next record" },
    });
    assertEquals(
      content.some((op) =>
        op.op === "message.upsert" && op.message.id === "msg_next"
      ),
      true,
    );
    assertEquals(reads, 1);
    release.resolve();
    const deadline = performance.now() + 1000;
    while (
      !content.some((op) =>
        op.op === "message.upsert" && op.message.id === "msg_shell"
      ) && performance.now() < deadline
    ) await new Promise((resolve) => setTimeout(resolve, 5));
    assertEquals(
      content.some((op) =>
        op.op === "message.upsert" && op.message.id === "msg_shell" &&
        op.message.sourceOrder === 1
      ),
      true,
    );
  } finally {
    release.resolve();
    await transcript.stop();
  }
});

Deno.test("V2 direct shell delivery supersedes a held lookup for the same shell", async () => {
  const lifetime = new AbortController(),
    entered = Promise.withResolvers<AbortSignal>(),
    release = Promise.withResolvers<void>();
  const client = new V2Client(
    { endpoint: { url: "http://fixture" }, version: "2.2.6", pid: 1 },
    1000,
    lifetime.signal,
  );
  const content: ContentOp[] = [];
  const transcript = new Transcript({
    client: () => client,
    policy: cfg().messages,
    content: (_id, op) => content.push(op),
    diagnostic: (error) => {
      throw error;
    },
    invalidated() {},
    facts: () =>
      Promise.resolve({
        source: "fixture",
        contexts: { msg_shell: { order: 1 } },
        metadata: { boundaries: [] },
      }),
  });
  transcript.reader.page = async (_id, _limit, _cursor, signal) => {
    entered.resolve(signal!);
    await release.promise;
    return {
      items: [{
        id: "msg_shell",
        type: "shell",
        shellID: "shell",
        command: "echo done",
        status: "running",
        time: { created: 1 },
      } as NativeMessage],
    };
  };
  transcript.subscriptions("opcv2-ses_shell_dispatch", 1);
  const shell = { id: "shell", command: "echo done", status: "running" };
  const start = {
    type: "session.shell.started",
    created: 1,
    data: { sessionID: "ses_shell_dispatch", shell },
  };
  try {
    await transcript.event(start);
    const signal = await entered.promise;
    await transcript.event({ ...start, id: "evt_shell" });
    await transcript.event({
      type: "session.shell.ended",
      created: 5,
      data: {
        sessionID: "ses_shell_dispatch",
        shell: { ...shell, status: "exited", exit: 0 },
      },
    });
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(
      content.filter((op) => op.op === "message.upsert").length,
      2,
      "A delayed start cannot publish over direct dispatch's terminal record",
    );
    assert(signal.aborted, "Direct delivery must retire the native lookup");
  } finally {
    release.resolve();
    await transcript.stop();
  }
});
