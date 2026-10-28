// SPDX-License-Identifier: LGPL-3.0-only
import { type DigestPublication, DigestScheduler } from "@otk/harness";
import {
  DigestDb,
  digestMigrations,
  DigestStore,
  digestTurnCursor,
} from "@otk/store";
import {
  opencodeV1DigestMigrations,
  OpencodeV1DigestSink,
} from "@otk/harness-opencode-v1";
import { type DigestDelta, errorMessage } from "@otk/protocol";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { snapshot, usage, write } from "./storage.ts";
import { DigestRequests } from "./requests.ts";

let run: string | undefined,
  db: DigestDb | undefined,
  store: DigestStore | undefined;
let scheduler: DigestScheduler | undefined,
  requests: DigestRequests | undefined,
  sink: OpencodeV1DigestSink | undefined;
let policy: Extract<ToWorker, { t: "start" }>["policy"];
const lifetime = new AbortController();
let credits = 1,
  wake: (() => void) | undefined,
  loop: Promise<void> | undefined,
  connection = 0;
const waitingCredit = new Set<() => void>();
let requestSignal: AbortSignal | undefined;
let catalogPublications: Set<string> | undefined;
let inventoryDirty = false;
let starting: Promise<void> | undefined;
function post(value: FromWorker): void {
  globalThis.postMessage(value);
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
async function send(
  value: FromWorker,
  signal = lifetime.signal,
): Promise<void> {
  while (credits < 1) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        waitingCredit.delete(ready);
        reject(signal.reason);
      };
      const ready = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      waitingCredit.add(ready);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  signal.throwIfAborted();
  credits--;
  post(value);
}
async function publish(value: DigestPublication): Promise<void> {
  if (catalogPublications) {
    catalogPublications.add(value.sessionID);
    return;
  }
  if (value.metadata) {
    await send({
      t: "catalog",
      run: run!,
      id: 0,
      connection,
      entries: [value.metadata],
      part: 0,
      last: true,
      authoritative: false,
    }, requestSignal ?? lifetime.signal);
  }
  const turns = Object.entries(value.delta.turns.upsert),
    remove = value.delta.turns.remove;
  const count = Math.max(
    1,
    Math.ceil((turns.length + remove.length) / policy.publishrows),
  );
  for (let part = 0; part < count; part++) {
    const from = part * policy.publishrows, to = from + policy.publishrows;
    const delta: DigestDelta = {
      ...value.delta,
      summary: {
        ...value.delta.summary,
        state: part === count - 1 ? value.delta.summary.state : "digesting",
      },
      turns: {
        upsert: Object.fromEntries(turns.slice(from, to)),
        remove: remove.slice(
          Math.max(0, from - turns.length),
          Math.max(0, to - turns.length),
        ),
      },
    };
    await send({
      t: "digest",
      run: run!,
      id: 0,
      sessionID: value.sessionID,
      revision: value.revision,
      part,
      last: part === count - 1,
      delta,
    }, requestSignal ?? lifetime.signal);
  }
}
function kick(): void {
  wake?.();
  wake = undefined;
}
async function pump(): Promise<void> {
  while (!lifetime.signal.aborted) {
    try {
      if (await scheduler!.tick()) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = undefined;
          resolve();
        }, policy.retryms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    } catch (error) {
      if (lifetime.signal.aborted) break;
      post({
        t: "error",
        run: run!,
        id: 0,
        scope: "worker",
        message: errorMessage(error),
      });
      await sleep(policy.retryms, lifetime.signal).catch(() => {});
    }
  }
}
async function start(
  message: Extract<ToWorker, { t: "start" }>,
): Promise<void> {
  if (run) throw new Error("Digest worker already started");
  run = message.run;
  policy = message.policy;
  try {
    const contributions = new Map([["opencode-v1", {
      migrations: opencodeV1DigestMigrations,
      create: () =>
        new OpencodeV1DigestSink(message.native, policy, {
          sql: db!.connection,
          transaction: (callback) => db!.transaction(callback),
          read: (id) => {
            const row = store!.summary([id])[0];
            return row && snapshot(row);
          },
          turn: (id, turn) => {
            const row = store!.turn(id, turn);
            return row && usage(row);
          },
          *known() {
            let after = "";
            while (true) {
              const rows = store!.catalog(
                message.provider,
                after,
                policy.batch,
              );
              if (!rows.length) return;
              for (const row of rows) yield snapshot(row);
              after = rows.at(-1)!.id;
            }
          },
          write: (metadata, delta, checkpoint) =>
            write(store!, message.provider, metadata, delta, checkpoint),
          publish,
          diagnostic: (sessionID, error) =>
            post({
              t: "error",
              run: run!,
              id: 0,
              scope: sessionID ? "session" : "worker",
              sessionID,
              message: errorMessage(error),
            }),
        }),
    }]]);
    const selected = contributions.get(message.provider);
    if (!selected) throw new Error("Unknown digest provider");
    db = new DigestDb(message.statePath, [
      digestMigrations,
      selected.migrations,
    ], { busyms: policy.busyms });
    store = new DigestStore(db);
    sink = selected.create();
    connection = message.connection ?? 0;
    sink.connection(connection);
    const selectedSink = sink;
    scheduler = new DigestScheduler(policy, {
      // Reclaimable page cache is capacity, not pressure. Deno's `available`
      // estimates admission without swapping; `free` counts unused pages only.
      freeMemory: () => Deno.systemMemoryInfo().available,
      sleep,
    });
    scheduler.register({
      identity: sink.identity,
      catalog: (signal) => selectedSink.catalog(signal),
      detail: (id, signal) => selectedSink.detail(id, signal),
      close: () => selectedSink.close(),
      step: async (job, budget, signal) => {
        try {
          if (inventoryDirty) {
            inventoryDirty = false;
            const catalog = await sink!.catalog(signal, false);
            for (const entry of catalog.entries) {
              const saved = store!.summary([entry.id])[0];
              if (saved.state !== "ready") {
                scheduler!.enqueue({
                  provider: sink!.identity,
                  sessionID: entry.id,
                  directory: entry.directory,
                  updated: entry.timeUpdated,
                }, "background");
              }
            }
          }
          return await sink!.step(job, budget, signal);
        } catch (error) {
          signal.throwIfAborted();
          const row = store!.summary([job.sessionID])[0];
          if (row) {
            const saved = snapshot(row);
            const delta: DigestDelta = {
              summary: {
                ...saved.summary,
                state: "unavailable",
                revision: saved.summary.revision + 1,
              },
              turns: { upsert: {}, remove: [] },
              deleted: saved.deleted,
            };
            db!.transaction(() =>
              write(store!, selectedSink.identity, saved.metadata, delta)
            );
            await publish({
              sessionID: job.sessionID,
              revision: delta.summary.revision,
              delta,
            });
          }
          post({
            t: "error",
            run: run!,
            id: 0,
            scope: "session",
            sessionID: job.sessionID,
            message: errorMessage(error),
          });
          return;
        }
      },
    });
    requests = new DigestRequests(run, scheduler);
    // Cached rows are usable before the provider's health/catalog round-trip.
    let cachedAfter = "";
    while (true) {
      const rows = store.catalog(
        message.provider,
        cachedAfter,
        policy.publishrows,
      );
      if (!rows.length) break;
      await send({
        t: "catalog",
        run,
        id: 0,
        connection: 0,
        entries: rows.map((row) => snapshot(row).metadata),
        part: 0,
        last: true,
        authoritative: false,
      });
      for (const row of rows) {
        const saved = snapshot(row);
        let after = "", part = 0;
        while (true) {
          const turns = store.turns([row.id], after, policy.publishrows);
          await send({
            t: "digest",
            run,
            id: 0,
            sessionID: row.id,
            revision: saved.summary.revision,
            part,
            last: turns.length < policy.publishrows,
            delta: {
              summary: {
                ...saved.summary,
                state: saved.deleted ? saved.summary.state : "digesting",
              },
              turns: {
                upsert: Object.fromEntries(
                  turns.map((turn) => [turn.turn_id, usage(turn)]),
                ),
                remove: [],
              },
              deleted: saved.deleted,
            },
          });
          if (turns.length < policy.publishrows) break;
          after = digestTurnCursor(turns.at(-1)!);
          part++;
        }
      }
      cachedAfter = rows.at(-1)!.id;
    }
    post({ t: "accepted", run, id: message.id });
    loop = pump();
  } catch (error) {
    await scheduler?.stop();
    sink?.close();
    db?.close();
    db = undefined;
    sink = undefined;
    throw error;
  }
}
async function stop(message: ToWorker): Promise<void> {
  lifetime.abort();
  kick();
  for (const ready of waitingCredit) ready();
  waitingCredit.clear();
  await starting?.catch(() => {});
  await requests?.stop();
  await scheduler?.stop();
  await loop;
  db?.close();
  db = undefined;
  post({ t: "stopped", run: message.run, id: message.id });
  globalThis.close();
}
function handle(message: ToWorker): void {
  if (message.t === "start") {
    starting = start(message);
    void starting.catch((error) => {
      if (!lifetime.signal.aborted) {
        post({
          t: "error",
          run: message.run,
          id: message.id,
          scope: "worker",
          message: errorMessage(error),
        });
      }
    });
    return;
  }
  if (message.run !== run) return;
  if (message.t === "stop") {
    void stop(message).catch((error) =>
      post({
        t: "error",
        run: run!,
        id: message.id,
        scope: "worker",
        message: errorMessage(error),
      })
    );
    return;
  }
  if (!requests || !scheduler || !sink) return;
  if (message.t === "cancel") {
    requests.cancel(message.run, message.request);
    kick();
    return;
  }
  if (message.t === "credit") {
    credits += message.publications;
    for (const ready of waitingCredit) ready();
    waitingCredit.clear();
    return;
  }
  if (message.t === "scope") {
    if (!message.sessions.length && message.directory === undefined) {
      scheduler.release(message.owner);
    } else scheduler.setScope(message.owner, message);
    kick();
    return;
  }
  if (message.t === "interactive") {
    scheduler.interactive(message.owner, message.active);
    kick();
    return;
  }
  if (message.t === "dirty") {
    if (message.connection !== connection) {
      post({ t: "accepted", run: run!, id: message.id });
      return;
    }
    db!.transaction(() => {
      for (const dirty of message.sessions) {
        const row = store!.summary([dirty.sessionID])[0];
        if (dirty.reason === "attention") {
          const identity = {
            provider: sink!.identity,
            sessionID: dirty.sessionID,
            directory: row?.directory,
            updated: row?.time_updated ?? Date.now(),
          };
          if (
            !scheduler!.promote(identity, "attention") && row &&
            !row.deleted_at && row.state !== "ready"
          ) scheduler!.enqueue(identity, "attention");
          continue;
        }
        if (
          !row || dirty.reason === "presence" || dirty.reason === "metadata"
        ) {
          inventoryDirty = true;
        }
        sink!.invalidate(dirty.sessionID, dirty.revision);
        scheduler!.enqueue(
          {
            provider: sink!.identity,
            sessionID: dirty.sessionID,
            directory: row?.directory,
            updated: row?.time_updated ?? Date.now(),
          },
          "background",
          dirty,
        );
      }
    });
    post({ t: "accepted", run: run!, id: message.id });
    kick();
    return;
  }
  const task = requests.run(run!, message.id, async (signal) => {
    requestSignal = signal;
    try {
      if (message.t === "catalog") {
        if (message.connection < connection) {
          throw new Error("Stale native connection");
        }
        connection = message.connection;
        sink!.connection(connection);
        const changed = catalogPublications = new Set<string>();
        let result: Awaited<ReturnType<OpencodeV1DigestSink["catalog"]>>;
        try {
          result = await sink!.catalog(signal);
        } finally {
          catalogPublications = undefined;
        }
        const entries = [];
        let catalogAfter = "";
        while (true) {
          const rows = store!.catalog(
            sink!.identity,
            catalogAfter,
            policy.batch,
          );
          if (!rows.length) break;
          entries.push(...rows.map((row) => snapshot(row).metadata));
          catalogAfter = rows.at(-1)!.id;
          signal.throwIfAborted();
        }
        for (
          let offset = 0, part = 0;
          offset < entries.length || part === 0;
          offset += policy.publishrows, part++
        ) {
          await send({
            t: "catalog",
            run: run!,
            id: message.id,
            connection,
            entries: entries.slice(offset, offset + policy.publishrows),
            part,
            last: offset + policy.publishrows >= entries.length,
            authoritative: result.authoritative,
            ...(offset === 0 ? { hints: result.hints } : {}),
          }, signal);
        }
        const pending = result.entries.filter((entry) =>
          store!.summary([entry.id])[0]?.state !== "ready"
        );
        db!.transaction(() => {
          for (const entry of pending) {
            sink!.invalidate(entry.id, 0);
          }
        });
        for (const entry of pending) {
          scheduler!.enqueue({
            provider: sink!.identity,
            sessionID: entry.id,
            directory: entry.directory,
            updated: entry.timeUpdated,
          }, entry.status === "idle" ? "background" : "attention");
        }
        for (const sessionID of changed) {
          let after = "", part = 0;
          const saved = snapshot(store!.summary([sessionID])[0]);
          while (true) {
            const turns = store!.turns([sessionID], after, policy.publishrows);
            await send({
              t: "digest",
              run: run!,
              id: 0,
              sessionID,
              revision: saved.summary.revision,
              part,
              last: turns.length < policy.publishrows,
              delta: {
                summary: {
                  ...saved.summary,
                  state: saved.summary.state,
                },
                turns: {
                  upsert: Object.fromEntries(
                    turns.map((turn) => [turn.turn_id, usage(turn)]),
                  ),
                  remove: [],
                },
                deleted: saved.deleted,
              },
            }, signal);
            if (turns.length < policy.publishrows) break;
            after = digestTurnCursor(turns.at(-1)!);
            part++;
          }
        }
      } else if (message.t === "deleted") {
        if (message.connection === connection) {
          for (const item of message.sessions) {
            await sink!.deleted(
              connection,
              item.sessionID,
              item.revision,
              item.metadata,
            );
          }
        }
        post({ t: "accepted", run: run!, id: message.id });
      } else if (message.t === "detail") {
        const detail = await sink!.detail(message.sessionID, signal);
        const turns = Object.entries(detail.turns);
        const count = Math.max(
          1,
          Math.ceil(
            Math.max(detail.messages.length, turns.length) / policy.publishrows,
          ),
        );
        for (let part = 0; part < count; part++) {
          await send({
            t: "detail",
            run: run!,
            id: message.id,
            sessionID: message.sessionID,
            part,
            last: part === count - 1,
            ...(part === 0 ? { total: detail.total } : {}),
            turns: Object.fromEntries(
              turns.slice(
                part * policy.publishrows,
                (part + 1) * policy.publishrows,
              ),
            ),
            messages: detail.messages.slice(
              part * policy.publishrows,
              (part + 1) * policy.publishrows,
            ),
          }, signal);
        }
      } else if (message.t === "deleteIntent") {
        await sink!.deleteIntent(
          message.sessionID,
          message.intent,
          message.phase,
          message.connection,
        );
        post({ t: "accepted", run: run!, id: message.id });
      }
    } finally {
      requestSignal = undefined;
    }
  });
  void task.catch((error) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      post({
        t: "error",
        run: run!,
        id: message.id,
        scope: "worker",
        message: errorMessage(error),
      });
    }
  });
  kick();
}
globalThis.onmessage = ({ data }: MessageEvent<ToWorker>) => handle(data);
