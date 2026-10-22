// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl, join } from "@std/path";
import type { Harness, HarnessSink } from "@otk/harness";
import type { ContentSession, IndexEntry, Message } from "@otk/protocol";
import { startApplication } from "../../application.ts";
import { cfg } from "./config.ts";
import { resources } from "./resources.ts";

/** Deterministic external backend through the real shipped core and inbox stores. */
export async function inboxBrowserFixture(
  root: string,
  origins: string[] = [],
  messages: Record<string, Message[]> = {},
  assets = fromFileUrl(new URL("../../web/dist/", import.meta.url)),
) {
  const scope = resources();
  const names = ["otk", "atmosphera", "globnotes", "luch"],
    entries: IndexEntry[] = [];
  for (const [n, name] of names.entries()) {
    const directory = join(root, "projects", name);
    await Deno.mkdir(directory, { recursive: true });
    entries.push({
      id: name,
      directory,
      projectID: name,
      title: ["Execution", "Approval", "Research", "Quiet session"][n],
      timeCreated: 1,
      timeUpdated: 1,
      archived: false,
      status: "idle",
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    });
  }
  entries.push({ ...entries[2], id: "other-finished", title: "Other session" });
  let sink!: HarnessSink;
  const content = (entry: IndexEntry): ContentSession => ({
    id: entry.id,
    directory: entry.directory,
    projectID: entry.projectID,
    title: entry.title,
    ...(entry.parentID ? { parentID: entry.parentID } : {}),
    archived: false,
    time: { created: entry.timeCreated, updated: entry.timeUpdated },
  });
  const update = (id: string, patch: Partial<IndexEntry>) => {
    const at = entries.findIndex((e) => e.id === id);
    entries[at] = {
      ...entries[at],
      ...patch,
      timeUpdated: entries[at].timeUpdated + 1,
    };
    sink.indexUpsert(entries[at]);
  };
  const backend: Harness = {
    core: {
      kind: "external",
      version: "1",
      start(value) {
        sink = value;
        sink.connection("connected");
        sink.indexReset(entries);
        return Promise.resolve();
      },
      stop: () => Promise.resolve(),
      subscriptions() {},
      getSession: (id) =>
        Promise.resolve(content(entries.find((e) => e.id === id)!)),
      listChildren: (id) =>
        Promise.resolve(entries.filter((e) => e.parentID === id).map(content)),
      listMessages: (id) =>
        Promise.resolve(
          messages[id] ?? [{
            id: `${id}-message`,
            sessionID: id,
            role: "user",
            time: { created: 1 },
            parts: [{
              id: `${id}-text`,
              kind: "text",
              synthetic: false,
              blocks: [{
                b: "paragraph",
                inline: [{ i: "text", text: `Transcript for ${id}` }],
              }],
            }],
          }],
        ),
      createSession(input) {
        const entry = {
          ...entries[0],
          id: crypto.randomUUID(),
          directory: input.directory,
          title: "New session",
        };
        entries.push(entry);
        sink.indexUpsert(entry);
        return Promise.resolve(content(entry));
      },
    },
    capabilities: {
      prompt: {
        prompt: () => Promise.resolve(),
        abort: () => Promise.resolve(),
      },
    },
  };
  const settings = cfg();
  settings.auth.type = "none";
  settings.server.port = 0;
  settings.server.origins = origins;
  settings.state.path = join(root, "state");
  const app = await startApplication(
    settings,
    backend,
    assets,
  );
  const stop = app.stop.bind(app);
  app.stop = scope.defer("inbox application", stop);
  return {
    app,
    entries,
    update,
    add(entry: IndexEntry) {
      entries.push(entry);
      sink.indexUpsert(entry);
    },
    url: `http://127.0.0.1:${app.server.addr.port}`,
  };
}

/** Browser-only mocked clock; production has no clock/debug escape hatch. */
export const inboxClockScript =
  `(()=>{globalThis.inboxNow=Date.now();Date.now=()=>globalThis.inboxNow;const interval=globalThis.setInterval;globalThis.setInterval=(fn,delay,...args)=>{if(delay===30000)globalThis.inboxTick=fn;return interval(fn,delay,...args)}})()`;
