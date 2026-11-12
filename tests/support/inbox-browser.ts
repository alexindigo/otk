// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl, join } from "@std/path";
import type { Harness, HarnessSink } from "@otk/harness";
import type { ContentSession, IndexEntry, Message } from "@otk/protocol";
import type { OtkDb } from "@otk/store";
import { startApplication } from "../../application.ts";
import { cfg } from "./config.ts";
import { resources } from "./resources.ts";
import { fixturePage } from "./message-pages.ts";

/** Deterministic external backend through the real shipped core and inbox stores. */
export async function inboxBrowserFixture(
  root: string,
  origins: string[] = [],
  messages: Record<string, Message[]> = {},
  assets = fromFileUrl(new URL("../../web/dist/", import.meta.url)),
  initialize?: (store: OtkDb, entries: IndexEntry[]) => void,
) {
  const scope = resources();
  const names = ["otk", "atmosphera", "globnotes", "luch"],
    entries: IndexEntry[] = [];
  for (const [n, name] of names.entries()) {
    const directory = join(root, "projects", name);
    await Deno.mkdir(directory, { recursive: true });
    entries.push({
      id: `tstv1-${name}`,
      directory,
      projectID: name,
      title: ["Execution", "Approval", "Research", "Quiet session"][n],
      timeCreated: 1,
      timeUpdated: 1,
      archived: false,
      status: "idle",
      digest: { state: "digesting", revision: 0, turns: {} },
      attention: {
        permissions: 0,
        questions: 0,
        childPermissions: 0,
        childQuestions: 0,
      },
    });
  }
  entries.push({
    ...entries[2],
    id: "tstv1-other-finished",
    title: "Other session",
  });
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
  // This external harness simulates positive native work/input/terminal facts
  // on every insertion path. Status and attention counts are scenario controls,
  // not application supervision inputs; explicit activity wins.
  const evidence = (
    entry: IndexEntry,
    previous?: IndexEntry,
  ): IndexEntry["activity"] => ({
    terminal: entry.status === "idle" && previous?.activity?.work?.keys.length
      ? Date.now()
      : previous?.activity?.terminal,
    work: {
      keys: entry.status === "idle" ? [] : [`fixture-run:${entry.id}`],
      fresh: true,
    },
    inputs: {
      keys: Array.from(
        { length: entry.attention.questions },
        (_, n) => `question:${entry.id}:${n}`,
      ),
      fresh: true,
    },
    permissions: {
      keys: Array.from(
        { length: entry.attention.permissions },
        (_, n) => `permission:${entry.id}:${n}`,
      ),
      fresh: true,
    },
  });
  const update = (id: string, patch: Partial<IndexEntry>) => {
    const at = entries.findIndex((e) => e.id === id), previous = entries[at];
    const entry: IndexEntry = {
      ...previous,
      ...patch,
      timeUpdated: previous.timeUpdated + 1,
    };
    entry.activity = patch.activity ?? evidence(entry, previous);
    entries[at] = entry;
    sink.indexUpsert(entry);
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
      identities: (ids) =>
        Promise.resolve(
          entries.filter((e) => ids.includes(e.id)).map((
            { id, directory, parentID },
          ) => ({ id, directory, parentID })),
        ),
      getSession: (id) =>
        Promise.resolve(content(entries.find((e) => e.id === id)!)),
      listChildren: (id) =>
        Promise.resolve(entries.filter((e) => e.parentID === id).map(content)),
      listSessions: (input) => {
        const values = entries.filter((entry) =>
          entry.directory === input.directory &&
          (input.parentID === undefined ||
            (input.parentID === null
              ? !entry.parentID
              : entry.parentID === input.parentID)) &&
          (!input.query ||
            entry.title.toLowerCase().includes(input.query.toLowerCase()))
        )
          .sort((a, b) =>
            b.timeUpdated - a.timeUpdated || b.id.localeCompare(a.id)
          );
        const offset = input.before ? Number(input.before) : 0,
          limit = input.limit ?? 20;
        return Promise.resolve({
          items: values.slice(offset, offset + limit),
          older: offset + limit < values.length ? String(offset + limit) : null,
          generation: "fixture",
        });
      },
      listMessages: (id, opts) =>
        Promise.resolve(
          fixturePage(
            id,
            messages[id] ?? [{
              id: `${id.slice(6)}-message`,
              sessionID: id,
              role: "user",
              time: { created: 1 },
              parts: [{
                id: `${id.slice(6)}-text`,
                kind: "text",
                synthetic: false,
                blocks: [{
                  b: "paragraph",
                  inline: [{
                    i: "text",
                    text: `Transcript for ${id.slice(6)}`,
                  }],
                }],
              }],
            }],
            opts.before,
            content(entries.find((entry) => entry.id === id)!),
          ),
        ),
      createSession(input) {
        const entry = {
          ...entries[0],
          id: `tstv1-${crypto.randomUUID()}`,
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
    { upgrade: (store) => initialize?.(store, entries) },
  );
  const stop = app.stop.bind(app);
  app.stop = scope.defer("inbox application", stop);
  return {
    app,
    entries,
    update,
    add(entry: IndexEntry) {
      // A new native session has no earlier facts; copied activity is not its own.
      entry = { ...entry, activity: evidence(entry) };
      entries.push(entry);
      sink.indexUpsert(entry);
    },
    url: `http://127.0.0.1:${app.server.addr.port}`,
  };
}

/** Browser-only mocked clock; production has no clock/debug escape hatch. */
export const inboxClockScript =
  `(()=>{globalThis.inboxNow=Date.now();Date.now=()=>globalThis.inboxNow;const interval=globalThis.setInterval;globalThis.setInterval=(fn,delay,...args)=>{if(delay===30000)globalThis.inboxTick=fn;return interval(fn,delay,...args)}})()`;
