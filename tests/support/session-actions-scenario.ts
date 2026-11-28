// SPDX-License-Identifier: LGPL-3.0-only
import { type Capabilities, ContentReplay } from "@otk/harness";
import type { ContentSession, HistoryEntry, Message } from "@otk/protocol";
import { coreBackendFixture } from "./core-backend.ts";
import { fixture } from "./config.ts";
import { fixtureMessagePolicy, fixturePage } from "./message-pages.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";

/** Public external-backend composition for additive menu capabilities. */
export async function sessionActionsScenario(history = true) {
  const root = await fixture(), id = "tstv1-core", calls: unknown[] = [];
  const input = "Keep session actions reversible until the next prompt.";
  const entry: HistoryEntry = {
    input,
    mode: "normal",
    parts: [{ kind: "text", text: input }],
    time: 1,
  };
  let committed = false;
  const replay = new ContentReplay({
    ...fixtureMessagePolicy,
    nonce: () => crypto.randomUUID(),
    emit: () => {},
  });
  let session: ContentSession;
  const changed = () => {
    f.app.index.upsertMetadata({
      ...f.app.index.getMetadata(id)!,
      title: session.title,
      archived: session.archived,
    });
  };
  const boundary = (messageID?: string, code = false) => {
    session = {
      ...session,
      revert: messageID
        ? {
          boundaryID: messageID,
          messageIDs: [messageID],
          files: code
            ? [{ path: "src/session.ts", additions: 2, deletions: 1 }]
            : [],
          prompt: {
            input,
            mode: "normal",
            parts: [{ kind: "text", text: input }],
            time: 1,
          },
        }
        : undefined,
    };
    f.app.connections.broadcast({
      t: "transcript.invalidated",
      ...replay.invalidate(id),
    });
    return Promise.resolve(session);
  };
  const capabilities: Capabilities = {
    prompt: {
      prompt: () => {
        calls.push(["prompt", id]);
        if (session.revert) committed = true;
        return boundary().then(() => {});
      },
      abort: () => Promise.resolve(),
    },
    ...(history
      ? {
        history: {
          entry: (target: string, messageID: string) => {
            calls.push(["history.prompt", target, messageID]);
            return Promise.resolve(
              target === id && messageID === "prompt-v4" ? entry : undefined,
            );
          },
          listHistory: () => Promise.resolve([entry]),
          attachments: () => Promise.resolve([]),
          attachment: () =>
            Promise.reject(new Error("This scene has no attachments")),
        },
      }
      : {}),
    sessionActions: {
      rename: (_id, title) => {
        session = { ...session, title };
        changed();
        return Promise.resolve(session);
      },
      remove: () => Promise.resolve(),
      fork: () => Promise.resolve(session),
      compact: () => Promise.resolve(),
    },
    sessionArchive: {
      archive: (target, archived) => {
        calls.push(["archive", target, archived]);
        session = { ...session, archived };
        changed();
        return Promise.resolve(session);
      },
    },
    revert: {
      revert: (target, messageID) => {
        calls.push(["revert", target, messageID]);
        return boundary(messageID);
      },
    },
    revertCode: {
      revert: (target, messageID) => {
        calls.push(["code", target, messageID]);
        return boundary(messageID, true);
      },
    },
    restore: {
      restore: () => {
        calls.push(["restore", id]);
        return boundary();
      },
    },
  };
  const f = await coreBackendFixture(root, capabilities);
  session = { ...f.session, title: "Session actions review" };
  changed();
  const messages: Message[] = [{
    id: "prompt-v4",
    sessionID: id,
    role: "user",
    time: { created: 1 },
    parts: [{
      kind: "text",
      id: "prompt-text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{
          i: "text",
          text: input,
        }],
      }],
    }],
  }, {
    id: "reply-v4",
    sessionID: id,
    role: "assistant",
    interrupted: false,
    replyTo: "prompt-v4",
    agent: "build",
    model: { provider: "fake", model: "scripted" },
    cost: 0,
    tokens: {
      input: 10,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: { created: 2, completed: 3, lastOutput: 3 },
    parts: [{
      kind: "text",
      id: "reply-text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{
          i: "text",
          text:
            "Revert from here changes the conversation. Revert code changes also rolls back the edited files. Restore remains available until the next prompt.",
        }],
      }],
    }],
  }];
  f.app.backend.core.getSession = () => Promise.resolve(session);
  f.app.backend.core.listMessages = () =>
    Promise.resolve({
      ...fixturePage(
        id,
        session.revert || committed ? [] : messages,
        undefined,
        session,
        replay.clock(id),
      ),
      version: replay.version(id),
    });
  if (history) {
    f.app.backend.core.snapshotMessages = (target, options, signal) => {
      signal?.throwIfAborted();
      if (target !== id) {
        return Promise.reject(new Error("Unknown scene session"));
      }
      calls.push(["history.messages", target, options.before]);
      return Promise.resolve({
        ...fixturePage(
          id,
          options.scope?.validate || options.before
            ? []
            : options.scope
            ? messages.filter((message) =>
              options.scope!.messageIDs.includes(message.id)
            )
            : messages,
          undefined,
          session,
          replay.clock(id),
        ),
        version: replay.version(id),
        ...(options.scope
          ? { revisions: replay.revisions(id, options.scope.messageIDs) }
          : {}),
      });
    };
  }
  const client = new WsClient(f.url);
  await client.connect(root, id);
  resources().defer("V4 menu client", () => client.close());
  await client.rpc("prefs.set", { key: "theme", value: "otk-dark" });
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
  const info = {
    root,
    url: f.url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [Number(new URL(f.url).port)],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign V4 menu lease");
      switch (frame.command) {
        case "beginTest":
          lease = { lease: crypto.randomUUID(), directory: root, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return { calls, frames: client.frames };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "stop":
          await client.close();
          await f.app.stop();
          return null;
        default:
          throw new Error("Command outside V4 menu scene");
      }
    },
  };
}
