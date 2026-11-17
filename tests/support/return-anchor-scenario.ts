// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import type { Harness } from "@otk/harness";
import type { ContentSession, IndexEntry, Message } from "@otk/protocol";
import { startApplication } from "../../application.ts";
import { cfg, fixture } from "./config.ts";
import { fixturePage } from "./message-pages.ts";
import { nativeBinary, nativeVersion } from "./native.ts";
import { resources } from "./resources.ts";
import { WsClient } from "./ws-client.ts";
import type { ControlRequest, Json, TestLease } from "./fixture-control.ts";

/** Small cooling policy, real client lifetime and cursor pages; no UI test hooks. */
export async function returnAnchorScenario() {
  const root = await fixture(), settings = cfg(), directory = root + "/project";
  await Deno.mkdir(directory);
  settings.auth.type = "none";
  settings.server.port = 0;
  settings.state.path = root + "/state";
  settings.messages.coolms = 50;
  const sessions: ContentSession[] = ["tstv1-return", "tstv1-away"].map((
    id,
  ) => ({
    id,
    directory,
    projectID: "return",
    title: id,
    archived: false,
    time: { created: 1, updated: 1 },
  }));
  const entries: IndexEntry[] = sessions.map((s) => ({
    id: s.id,
    directory,
    projectID: "return",
    title: s.title,
    archived: false,
    timeCreated: 1,
    timeUpdated: 1,
    status: "idle",
    digest: { state: "digesting", revision: 0, turns: {} },
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  }));
  const messages: Message[] = Array.from({ length: 40 }, (_, n) => ({
    id: "return-" + n,
    sessionID: sessions[0].id,
    role: "user",
    time: { created: n + 1 },
    parts: [{
      id: "text-" + n,
      kind: "text",
      synthetic: false,
      blocks: [
        { b: "paragraph", inline: [{ i: "text", text: "Return prompt " + n }] },
        ...Array.from(
          { length: 8 },
          (_, p) => ({
            b: "paragraph" as const,
            inline: [{
              i: "text" as const,
              text: `Reading paragraph ${n}/${p}. ` +
                "A source anchor must yield only to a newer reader intent. "
                  .repeat(5),
            }],
          }),
        ),
      ],
    }],
  }));
  let reads = 0;
  const backend: Harness = {
    core: {
      kind: "external",
      version: "fixture",
      start(sink) {
        sink.connection("connected");
        sink.indexReset(entries);
        return Promise.resolve();
      },
      stop: async () => {},
      subscriptions() {},
      identities: (ids) =>
        Promise.resolve(
          entries.filter((e) => ids.includes(e.id)).map((
            { id, directory },
          ) => ({
            id,
            directory,
          })),
        ),
      getSession: (id) => Promise.resolve(sessions.find((s) => s.id === id)!),
      listChildren: () => Promise.resolve([]),
      listSessions: () =>
        Promise.resolve({
          items: entries,
          older: null,
          generation: "return",
        }),
      createSession: () => Promise.resolve(sessions[0]),
      listMessages: (id, options) => {
        reads++;
        return Promise.resolve(fixturePage(
          id,
          id === sessions[0].id ? messages : [],
          options.before,
          sessions.find((s) => s.id === id),
        ));
      },
    },
    capabilities: { prompt: { prompt: async () => {}, abort: async () => {} } },
  };
  const app = await startApplication(
    settings,
    backend,
    fromFileUrl(new URL("../../web/dist/", import.meta.url)),
  );
  resources().defer("return anchor application", () => app.stop());
  const url = `http://127.0.0.1:${app.server.addr.port}`,
    client = new WsClient(url);
  await client.connect(directory);
  resources().defer("return anchor observer", () => client.close());
  const baseline = await client.rpc<Record<string, Json>>("prefs.get", {});
  let lease: TestLease | undefined;
  const info = {
    root,
    url,
    nativeUrl: "",
    binary: nativeBinary,
    version: nativeVersion,
    pids: [Deno.pid],
    ports: [app.server.addr.port],
  };
  const record = Deno.env.get("OTK_TEST_CONTROLLER_RECORD");
  if (record) await Deno.writeTextFile(record, JSON.stringify(info));
  return {
    info,
    async dispatch(frame: ControlRequest): Promise<unknown> {
      if (
        "lease" in frame.params && frame.params.lease !== undefined &&
        frame.params.lease !== lease?.lease
      ) throw new Error("Foreign return-anchor lease");
      switch (frame.command) {
        case "beginTest":
          lease = { lease: crypto.randomUUID(), directory, baseline };
          return lease;
        case "endTest":
          lease = undefined;
          return null;
        case "observe":
          return {
            reads,
            coolms: settings.messages.coolms,
            target: sessions[0].id,
            away: sessions[1].id,
          };
        case "productRpc":
          return await client.rpc(frame.params.method, frame.params.params);
        case "stop":
          await client.close();
          await app.stop();
          return null;
        default:
          throw new Error("Command outside return-anchor fixture");
      }
    },
  };
}
