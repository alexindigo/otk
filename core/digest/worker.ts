// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DigestExecution,
  type DigestPublication,
  DigestScheduler,
  type ProviderReadKinds,
} from "@otk/harness";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  DigestDb,
  digestMigrations,
  DigestStore,
  digestTurnCursor,
} from "@otk/store";
import { selectDigestProvider, type WorkerDigestSink } from "./providers.ts";
import type { ProviderReadCodecs } from "@otk/harness";
import {
  type DigestDelta,
  errorMessage,
  isCancellation,
  OperationFailure,
  type SessionMetadata,
} from "@otk/protocol";
import type { FromWorker, ToWorker } from "./protocol.ts";
import { helper, snapshot, usage, write } from "./storage.ts";
import { DigestRequests } from "./requests.ts";
import { sqliteBusy, sqliteRetry } from "./sqlite-lock.ts";
import { DigestReadGate } from "./read-gate.ts";
import {
  DigestPublicationOrder,
  type DigestPublicationReservation,
} from "./publication-order.ts";
import { DigestBatch } from "./batch.ts";
import { DigestProgress } from "./progress.ts";

let progress: DigestProgress | undefined;
let diagnostics = false;
let progressTimer: ReturnType<typeof setInterval> | undefined;
let nativeWaiting = 0;
let nativeUnavailable = false;
const nativeReads: Record<string, number> = {};

let run: string | undefined,
  db: DigestDb | undefined,
  store: DigestStore | undefined;
let scheduler: DigestScheduler | undefined,
  requests: DigestRequests | undefined,
  sink: WorkerDigestSink | undefined;
let policy: Extract<ToWorker, { t: "start" }>["policy"];
let readCodecs: ProviderReadCodecs = {};
const lifetime = new AbortController();
let credits = 1,
  wake: (() => void) | undefined,
  loop: Promise<void> | undefined,
  connection = 0;
const waitingCredit = new Set<() => void>();
const execution = new AsyncLocalStorage<{
  signal: AbortSignal;
  turn: DigestExecution;
  catalogPublications?: Map<string, DigestPublicationReservation>;
  nativeReads?: Record<string, number>;
  headerRows?: { limit: number; rows: number }[];
  publishing?(): void;
}>();
function wait<T>(readiness: Promise<T>): Promise<T> {
  return execution.getStore()?.turn.wait(readiness) ?? readiness;
}
function yieldChunk(
  signal = execution.getStore()?.signal ?? lifetime.signal,
): Promise<void> {
  return wait(sleep(0, signal));
}
const publicationOrder = new DigestPublicationOrder(
  wait,
  (signal, publish, reservation) =>
    wait(scheduler!.execute(
      (signal, turn) => execution.run({ signal, turn }, publish),
      signal,
      () => reservation.priority(),
      false,
      () => reservation.required(),
      true,
    )),
  () => scheduler?.reconsider(),
);
const publishedRevisions = new Map<string, number>();
const nativeReadsGate = new DigestReadGate();
const servingReads = new Map<
  number,
  { controller: AbortController; release?: () => void }
>();
function releaseServing(id: number): void {
  const value = servingReads.get(id);
  if (!value) return;
  servingReads.delete(id);
  value.controller.abort();
  value.release?.();
}
function nativeWait<T>(readiness: Promise<T>, join = false): Promise<T> {
  nativeWaiting++;
  readiness = readiness.finally(() => {
    nativeWaiting--;
  });
  const turn = execution.getStore()?.turn;
  return turn
    ? (join ? turn.join(readiness) : turn.wait(readiness, "io"))
    : readiness;
}
let inventoryRevision = 0, inventoryComplete = 0;
let starting: Promise<void> | undefined;
let batches: DigestBatch | undefined;
let cachedReplay:
  | { controller: AbortController; task: Promise<void> }
  | undefined;
let wakeGeneration = 0;
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
  signal = execution.getStore()?.signal ?? lifetime.signal,
): Promise<void> {
  if (value.t === "digest") {
    if (!batches) throw new Error("Digest publication queue is unavailable");
    await batches.append({
      sessionID: value.sessionID,
      revision: value.revision,
      part: value.part,
      last: value.last,
      delta: value.delta,
    }, signal);
    return;
  }
  await sendRaw(value, signal);
}
async function sendRaw(
  value: FromWorker,
  signal = execution.getStore()?.signal ?? lifetime.signal,
): Promise<void> {
  while (credits < 1) {
    signal.throwIfAborted();
    await wait(
      new Promise<void>((resolve, reject) => {
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
      }),
    );
  }
  signal.throwIfAborted();
  credits--;
  post(value);
  // A completed publication is one bounded chunk, even when more credit is ready.
  await yieldChunk(signal);
}
/** Preserve the contribution's correlated input/result type across dynamic dispatch. */
async function publishRead<K extends keyof ProviderReadKinds>(
  message: { kind: K; input: ProviderReadKinds[K]["input"]; id: number },
  signal: AbortSignal,
): Promise<void> {
  const reader = sink!.readers[message.kind], codec = readCodecs[message.kind];
  if (!reader || !codec) throw new Error("Provider read not selected");
  const value = await reader(message.input, signal);
  signal.throwIfAborted();
  execution.getStore()?.publishing?.();
  const chunks = codec.chunks(value, policy.publishrows)[Symbol.iterator]();
  let current = chunks.next(), part = 0;
  while (!current.done) {
    const next = chunks.next();
    // K correlates kind/value; the mapped wire union erases that generic witness.
    await send(
      {
        t: "read.result",
        run: run!,
        id: message.id,
        kind: message.kind,
        part: part++,
        last: !!next.done,
        value: current.value,
      } as FromWorker,
      signal,
    );
    current = next;
  }
}
async function publish(value: DigestPublication): Promise<void> {
  progress?.update(
    value.sessionID,
    value.delta.summary.state === "ready",
    value.delta.summary.messageCount ?? 0,
    value.metadata?.directory,
  );
  const context = execution.getStore();
  if (context?.catalogPublications) {
    if (!context.catalogPublications.has(value.sessionID)) {
      context.catalogPublications.set(
        value.sessionID,
        publicationOrder.reserve(value.sessionID),
      );
    }
    return;
  }
  const signal = context?.signal ?? lifetime.signal;
  await publicationOrder.reserve(
    value.sessionID,
    context?.turn.priority ?? "attention",
  ).run(signal, async () => {
    if (value.revision < (publishedRevisions.get(value.sessionID) ?? -1)) {
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
      }, context?.signal ?? lifetime.signal);
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
      }, context?.signal ?? lifetime.signal);
    }
    publishedRevisions.set(value.sessionID, value.revision);
  });
}
/** A temporary scalar snapshot, captured in bounded reads before credit waits.
 * Interleaved writes invalidate capture, never splice two revisions together. */
async function publishStored(
  sessionID: string,
  cached = false,
  reserved = publicationOrder.reserve(sessionID, "background", true),
): Promise<void> {
  const signal = execution.getStore()?.signal ?? lifetime.signal;
  await reserved.run(signal, async () => {
    for (;;) {
      signal.throwIfAborted();
      const row = store!.summary([sessionID])[0];
      if (!row) return;
      const saved = snapshot(row), revision = saved.summary.revision;
      const progress = store!.helpers([sessionID])[0];
      const parts: FromWorker[] = [];
      let after = "", part = 0, changed = false;
      for (;;) {
        const turns = store!.turns([sessionID], after, policy.publishrows);
        parts.push({
          t: "digest",
          run: run!,
          id: 0,
          sessionID,
          revision,
          part,
          last: turns.length < policy.publishrows,
          delta: {
            helper: progress ? helper(progress) : null,
            summary: {
              ...saved.summary,
              state: cached && !saved.deleted
                ? "digesting"
                : saved.summary.state,
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
        await yieldChunk(signal);
        if (store!.summary([sessionID])[0]?.revision !== revision) {
          changed = true;
          break;
        }
      }
      if (changed) continue;
      if (revision < (publishedRevisions.get(sessionID) ?? -1)) return;
      for (const value of parts) await send(value, signal);
      publishedRevisions.set(sessionID, revision);
      return;
    }
  });
}
/** Rebuildable digest replay parks between identities without a native permit. */
function replayStored(signal: AbortSignal, cached: boolean): Promise<void> {
  return scheduler!.execute(
    (signal, turn) =>
      execution.run({ signal, turn }, async () => {
        let after = "";
        for (;;) {
          const rows = store!.catalog(
            sink!.identity,
            after,
            policy.publishrows,
          );
          if (!rows.length) return;
          for (const row of rows) {
            await publishStored(row.id, cached);
            await yieldChunk(signal);
          }
          after = rows.at(-1)!.id;
        }
      }),
    signal,
    "background",
    false,
    false,
    true,
  );
}
function kick(): void {
  wakeGeneration++;
  wake?.();
  wake = undefined;
}
/** Catalog/dirty-inventory admission shares bounded reads and real task yields. */
async function admitCatalog(
  entries: readonly SessionMetadata[],
  signal: AbortSignal,
  options: { invalidate: boolean; helpers: boolean },
): Promise<void> {
  const admitted = connection;
  for (let offset = 0; offset < entries.length; offset += policy.batch) {
    signal.throwIfAborted();
    if (connection !== admitted) {
      throw new Error("Digest catalog generation was replaced");
    }
    const chunk = entries.slice(offset, offset + policy.batch);
    const saved = new Map(
      store!.summary(chunk.map((entry) => entry.id)).map((
        row,
      ) => [row.id, row]),
    );
    for (const entry of chunk) {
      const row = saved.get(entry.id);
      progress?.row(
        entry.id,
        entry.directory,
        row?.state === "ready",
        row?.message_count ?? 0,
      );
    }
    const pending = chunk.filter((entry) => {
      const row = saved.get(entry.id);
      return row && !row.deleted_at && sink!.pending(entry.id);
    });
    if (options.invalidate) {
      db!.transaction(() => {
        for (const entry of pending) sink!.invalidate(entry.id, 0);
      });
    }
    for (const entry of pending) {
      scheduler!.enqueue({
        provider: sink!.identity,
        sessionID: entry.id,
        directory: entry.directory,
        updated: entry.timeUpdated,
      }, "background");
    }
    for (const entry of chunk) {
      if (!entry.parentID || saved.get(entry.id)?.deleted_at) continue;
      if (options.helpers) sink!.invalidateHelper(entry.id);
      // A hint may finish before this identity is discovered. Catalog admission
      // owns resuming its persisted dirty intent, without restarting ready work.
      else if (!sink!.requestHelper(entry.id, false)) continue;
      scheduler!.enqueue({
        provider: sink!.identity,
        sessionID: entry.id,
        directory: entry.directory,
        updated: entry.timeUpdated,
        projection: "helper",
        interruptible: true,
      }, "background");
    }
    await yieldChunk(signal);
  }
}
async function idle(generation: number): Promise<void> {
  if (generation !== wakeGeneration || lifetime.signal.aborted) return;
  await new Promise<void>((resolve) => {
    wake = () => {
      resolve();
    };
  });
}
async function pump(): Promise<void> {
  while (!lifetime.signal.aborted) {
    const generation = wakeGeneration;
    try {
      if (await scheduler!.tick()) {
        // The turn is released. Let incoming worker messages enter the priority
        // queue before selecting the next ready continuation.
        await sleep(0, lifetime.signal);
        continue;
      }
      if (batches?.flush()) continue;
      if (diagnostics) {
        post({
          t: "pressure",
          run: run!,
          id: 0,
          queued: scheduler!.queued,
          active: scheduler!.executing,
          sliceMs: 0,
          nativeActive: nativeReadsGate.optionalActive,
          publicationWaiting: waitingCredit.size,
          heldCredits: Math.max(0, 1 - credits),
          nativeReads: { ...nativeReads },
        });
      }
      await idle(generation);
    } catch (error) {
      if (lifetime.signal.aborted) break;
      post({
        t: "error",
        run: run!,
        id: 0,
        scope: "worker",
        message: errorMessage(error),
      });
    }
  }
}
async function start(
  message: Extract<ToWorker, { t: "start" }>,
): Promise<void> {
  if (run) throw new Error("Digest worker already started");
  run = message.run;
  policy = message.policy;
  diagnostics = !!message.diagnostics;
  progress = new DigestProgress(`${message.run}:0`);
  // No session catalog is enrolled at startup. Progress describes acquired
  // keyed work; explicit catalog compatibility requests establish their own
  // enumeration generation below.
  progress.complete();
  progressTimer = setInterval(() => {
    post({
      t: "progress",
      run: run!,
      id: 0,
      values: progress!.values(
        nativeUnavailable
          ? "native unavailable"
          : waitingCredit.size
          ? "waiting for publication credit"
          : scheduler?.waitReason ??
            (nativeWaiting ? "waiting for native data" : undefined),
      ),
    });
  }, 1000);
  try {
    const selected = selectDigestProvider(message.provider, message.native);
    readCodecs = selected.reads;
    const create = () =>
      selected.create(
        policy,
        {
          sql: db!.connection,
          transaction: (callback) => db!.transaction(callback),
          read: (id) => {
            const row = store!.summary([id])[0];
            const progress = store!.helpers([id])[0];
            return row &&
              {
                ...snapshot(row),
                ...(progress ? { helper: helper(progress) } : {}),
              };
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
        },
        {
          wait,
          listed: (entries, signal) =>
            admitCatalog(entries, signal, {
              invalidate: false,
              helpers: false,
            }),
          prefetchList: (input, read) =>
            scheduler!.prefetchList(input, (signal, turn) =>
              execution.run({ signal, turn }, () =>
                read(signal))),
          demanded: (entry) => {
            const row = store!.summary([entry.id])[0];
            if (row && sink!.pending(entry.id) && !row.deleted_at) {
              const identity = {
                provider: message.provider,
                sessionID: entry.id,
                directory: entry.directory,
                updated: entry.timeUpdated,
                backfill: "high" as const,
              };
              if (!scheduler!.promote(identity, "attention")) {
                scheduler!.enqueue(identity, "attention");
              }
            }
          },
          ioWait: nativeWait,
          retryable: sqliteBusy,
          admission: (signal) =>
            nativeReadsGate.acquire(
              signal,
              execution.getStore()?.turn.priority === "interactive",
              () =>
                scheduler!.interruptIO(signal),
            ),
          work: (ms) => execution.getStore()?.turn.charge(ms),
        },
        message.diagnostics
          ? (operation, sample) => {
            nativeReads[operation] = (nativeReads[operation] ?? 0) + 1;
            const context = execution.getStore();
            if (context?.nativeReads) {
              context.nativeReads[operation] =
                (context.nativeReads[operation] ?? 0) + 1;
            }
            if (sample) context?.headerRows?.push(sample);
          }
          : undefined,
      );
    db = await sqliteRetry(
      () =>
        new DigestDb(message.statePath, [
          digestMigrations,
          selected.migrations,
        ], { busyms: 0 }),
      lifetime.signal,
      policy,
      wait,
    );
    store = new DigestStore(db);
    sink = create();
    connection = message.connection ?? 0;
    sink.connection(connection);
    const selectedSink = sink;
    scheduler = new DigestScheduler(policy, {
      // Reclaimable page cache is capacity, not pressure. Deno's `available`
      // estimates admission without swapping; `free` counts unused pages only.
      freeMemory: () => Deno.systemMemoryInfo().available,
      sleep,
      wake: kick,
      discover: (signal, turn) =>
        execution.run({ signal, turn }, async () => {
          progress?.enumerate();
          const { entries, complete } = await selectedSink.discover(signal);
          await admitCatalog(entries, signal, {
            invalidate: false,
            helpers: true,
          });
          if (complete) progress?.complete();
          if (!entries.length && !complete) {
            await wait(sleep(policy.retryms, signal));
          }
          return !complete;
        }),
    });
    scheduler.viewers(false);
    batches = new DigestBatch({
      rows: policy.publishrows,
      signal: lifetime.signal,
      wait,
      schedule: (write) =>
        scheduler!.execute(
          (signal, turn) => execution.run({ signal, turn }, write),
          lifetime.signal,
          execution.getStore()?.turn.priority ?? "background",
          false,
          true,
        ),
      send: (values) => sendRaw({ t: "digests", run: run!, id: 0, values }),
    });
    scheduler.register({
      identity: sink.identity,
      catalog: (signal) => selectedSink.catalog(signal),
      detail: (id, turnID, signal) => selectedSink.detail(id, turnID, signal),
      close: () => selectedSink.close(),
      step: (job, budget, signal, turn) =>
        execution.run(
          { signal, turn, nativeReads: {}, headerRows: [] },
          () =>
            sqliteRetry(
              async () => {
                try {
                  if (
                    inventoryRevision > inventoryComplete ||
                    !store!.summary([job.sessionID]).length
                  ) {
                    const admitted = inventoryRevision;
                    const entries = await sink!.hydrate(
                      [job.sessionID],
                      signal,
                    );
                    await admitCatalog(entries, signal, {
                      invalidate: false,
                      helpers: false,
                    });
                    inventoryComplete = Math.max(inventoryComplete, admitted);
                  }
                  const start = performance.now();
                  const work = turn.workms;
                  const cursor = await sink!.step(job, budget, signal, turn);
                  nativeUnavailable = (job.projection === "helper"
                    ? store!.helpers([job.sessionID])[0]?.state
                    : store!.summary([job.sessionID])[0]?.state) ===
                    "unavailable";
                  if (!cursor && nativeUnavailable) {
                    await wait(sleep(policy.retryms, signal));
                    return "reconcile";
                  }
                  progress?.chunk(job.directory, turn.workms - work);
                  if (message.diagnostics) {
                    post({
                      t: "pressure",
                      run: run!,
                      id: 0,
                      queued: scheduler!.queued,
                      active: 1,
                      sliceMs: performance.now() - start,
                      nativeReads: { ...nativeReads },
                      sliceReads: { ...execution.getStore()!.nativeReads },
                      headerRows: execution.getStore()!.headerRows,
                    });
                  }
                  return cursor;
                } catch (error) {
                  signal.throwIfAborted();
                  if (sqliteBusy(error)) throw error;
                  nativeUnavailable = true;
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
                      write(
                        store!,
                        selectedSink.identity,
                        saved.metadata,
                        delta,
                      )
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
                  await wait(sleep(policy.retryms, signal));
                  return "reconcile";
                }
              },
              signal,
              policy,
              wait,
            ),
        ),
    });
    requests = new DigestRequests(run, scheduler);
    loop = pump();
    // Retained sessions are hydrated by key, never replayed as a startup catalog.
    post({ t: "accepted", run, id: message.id });
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
  clearInterval(progressTimer);
  lifetime.abort();
  for (const id of servingReads.keys()) releaseServing(id);
  kick();
  for (const ready of waitingCredit) ready();
  waitingCredit.clear();
  const closing = scheduler?.stop();
  await starting?.catch(() => {});
  await closing;
  await requests?.stop();
  await batches?.close();
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
  if (message.t === "discovery.project") {
    sink.discoveryProject(message.directory, message.active);
    scheduler.discoveryChanged();
    return;
  }
  if (message.t === "native.acquire") {
    const controller = new AbortController(),
      value = { controller } as {
        controller: AbortController;
        release?: () => void;
      };
    servingReads.set(message.id, value);
    void nativeReadsGate.acquire(controller.signal, true).then((release) => {
      if (controller.signal.aborted) {
        release();
        return;
      }
      value.release = release;
      post({ t: "native.granted", run: run!, id: message.id });
    }, () => {});
    return;
  }
  if (message.t === "native.release") {
    releaseServing(message.request);
    return;
  }
  if (message.t === "cancel" || message.t === "read.cancel") {
    if (message.t === "cancel") releaseServing(message.request);
    requests.cancel(
      message.run,
      message.t === "cancel" ? message.request : message.id,
    );
    kick();
    return;
  }
  if (message.t === "credit") {
    if (message.workms) scheduler.charge(message.workms);
    credits += message.publications;
    for (const ready of waitingCredit) ready();
    waitingCredit.clear();
    return;
  }
  if (message.t === "scope") {
    if (message.released) {
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
  if (message.t === "requested") {
    scheduler.requested(message.elapsed);
    return;
  }
  if (message.t === "dirty") {
    const task = requests.run(
      run!,
      message.id,
      (signal, turn) =>
        execution.run({ signal, turn }, () =>
          sqliteRetry(
            () => {
              signal.throwIfAborted();
              if (message.connection !== connection) {
                post({ t: "accepted", run: run!, id: message.id });
                return;
              }
              db!.transaction(() => {
                for (const dirty of message.sessions) {
                  let row = store!.summary([dirty.sessionID])[0];
                  if (!row && dirty.metadata?.id === dirty.sessionID) {
                    write(store!, sink!.identity, dirty.metadata, {
                      summary: { state: "digesting", revision: 0 },
                      turns: { upsert: {}, remove: [] },
                      deleted: null,
                    });
                    row = store!.summary([dirty.sessionID])[0];
                  }
                  if (
                    dirty.reason === "helper" || dirty.reason === "helper-hint"
                  ) {
                    if (
                      sink!.requestHelper(
                        dirty.sessionID,
                        dirty.reason === "helper",
                      )
                    ) {
                      const identity = {
                        provider: sink!.identity,
                        sessionID: dirty.sessionID,
                        directory: row?.directory,
                        updated: row?.time_updated ?? Date.now(),
                        projection: "helper" as const,
                        interruptible: true,
                      };
                      if (
                        dirty.reason !== "helper-hint" ||
                        !scheduler!.promote(identity, "visible")
                      ) {
                        scheduler!.enqueue(
                          identity,
                          "visible",
                          dirty.reason === "helper" ? dirty : undefined,
                        );
                      }
                    }
                    if (!row) inventoryRevision++;
                    continue;
                  }
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
                    !row || dirty.reason === "presence" ||
                    dirty.reason === "metadata"
                  ) {
                    inventoryRevision++;
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
            },
            signal,
            policy,
            wait,
          )),
    );
    observeTask(task, message);
    kick();
    return;
  }
  let publishing = false;
  const task = requests.run(
    run!,
    message.id,
    (signal, turn) =>
      execution.run(
        { signal, turn, publishing: () => publishing = true },
        () =>
          sqliteRetry(
            async () => {
              if (message.t === "hydrate") {
                const publishKeys = async (
                  entries: readonly SessionMetadata[],
                ) => {
                  for (
                    let offset = 0;
                    offset < message.sessions.length;
                    offset += policy.publishrows
                  ) {
                    const keys = message.sessions.slice(
                      offset,
                      offset + policy.publishrows,
                    );
                    const retained = store!.summary(keys).map(snapshot);
                    await send({
                      t: "catalog",
                      run: run!,
                      id: 0,
                      connection,
                      entries: keys.flatMap((id) =>
                        entries.find((entry) => entry.id === id) ??
                          retained.find((row) => row.metadata.id === id)
                            ?.metadata ??
                          []
                      ),
                      part: 0,
                      last: true,
                      authoritative: false,
                    }, signal);
                    for (const value of retained) {
                      await publishStored(
                        value.metadata.id,
                        false,
                        publicationOrder.reserve(
                          value.metadata.id,
                          turn.priority,
                        ),
                      );
                    }
                  }
                };
                // A keyed last-good baseline is independent of native readiness.
                await publishKeys([]);
                if (!message.retained) {
                  let entries: SessionMetadata[];
                  try {
                    entries = await sink!.hydrate(message.sessions, signal);
                  } catch (error) {
                    signal.throwIfAborted();
                    if (
                      !(error instanceof OperationFailure) ||
                      error.outcome !== "unavailable" ||
                      store!.summary(message.sessions).length !==
                        message.sessions.length
                    ) throw error;
                    nativeUnavailable = true;
                    post({ t: "accepted", run: run!, id: message.id });
                    return;
                  }
                  await publishKeys(entries);
                  await admitCatalog(entries, signal, {
                    invalidate: false,
                    helpers: true,
                  });
                }
                post({ t: "accepted", run: run!, id: message.id });
              } else if (message.t === "projects") {
                if (message.connection < connection) {
                  throw new Error("Stale native connection");
                }
                connection = message.connection;
                sink!.connection(connection);
                let part = 0;
                const value = await sink!.projects(signal, async (projects) => {
                  for (
                    let offset = 0;
                    offset < projects.length;
                    offset += policy.publishrows
                  ) {
                    await send({
                      t: "projects",
                      run: run!,
                      id: message.id,
                      projects: projects.slice(
                        offset,
                        offset + policy.publishrows,
                      ),
                      part: part++,
                      last: false,
                    }, signal);
                  }
                }, message.directory);
                await send({
                  t: "projects",
                  run: run!,
                  id: message.id,
                  projects: [],
                  hints: value.hints,
                  part,
                  last: true,
                }, signal);
              } else if (message.t === "catalog") {
                if (message.connection < connection) {
                  throw new Error("Stale native connection");
                }
                if (cachedReplay) {
                  const cached = cachedReplay;
                  cachedReplay = undefined;
                  cached.controller.abort(
                    new DOMException(
                      "Fresh catalog supersedes cached publication",
                      "AbortError",
                    ),
                  );
                  await wait(cached.task.catch((error) => {
                    if (
                      !isCancellation(error)
                    ) throw error;
                  }));
                }
                connection = message.connection;
                progress = new DigestProgress(
                  `${run}:${connection}:${message.id}`,
                );
                sink!.connection(connection);
                const current = () => {
                  signal.throwIfAborted();
                  if (connection !== message.connection) {
                    throw new Error("Digest catalog generation was replaced");
                  }
                };
                const context = execution.getStore()!;
                const changed = context.catalogPublications = new Map<
                  string,
                  DigestPublicationReservation
                >();
                try {
                  let result: Awaited<
                    ReturnType<WorkerDigestSink["catalog"]>
                  >;
                  try {
                    result = await sink!.catalog(signal);
                  } finally {
                    context.catalogPublications = undefined;
                  }
                  const entries = [];
                  let catalogAfter = "";
                  while (true) {
                    current();
                    const rows = store!.catalog(
                      sink!.identity,
                      catalogAfter,
                      policy.batch,
                    );
                    if (!rows.length) break;
                    for (const row of rows) {
                      progress?.row(
                        row.id,
                        row.directory,
                        row.state === "ready",
                        row.message_count ?? 0,
                      );
                    }
                    entries.push(...rows.map((row) => snapshot(row).metadata));
                    // This catalog supersedes cached replay, including unchanged
                    // tombstones whose digest chunks may not have arrived yet.
                    for (const row of rows) {
                      if (!changed.has(row.id)) {
                        changed.set(row.id, publicationOrder.reserve(row.id));
                      }
                    }
                    catalogAfter = rows.at(-1)!.id;
                    await yieldChunk(signal);
                  }
                  for (
                    let offset = 0, part = 0;
                    offset < entries.length || part === 0;
                    offset += policy.publishrows, part++
                  ) {
                    current();
                    await send({
                      t: "catalog",
                      run: run!,
                      id: message.id,
                      connection,
                      entries: entries.slice(
                        offset,
                        offset + policy.publishrows,
                      ),
                      part,
                      last: offset + policy.publishrows >= entries.length,
                      authoritative: result.authoritative,
                      ...(offset === 0 ? { hints: result.hints } : {}),
                    }, signal);
                  }
                  current();
                  await admitCatalog(result.entries, signal, {
                    invalidate: true,
                    helpers: true,
                  });
                  progress?.complete();
                  scheduler!.discoveryComplete();
                  const controller = new AbortController();
                  const task = replayStored(
                    AbortSignal.any([controller.signal, lifetime.signal]),
                    false,
                  );
                  cachedReplay = { controller, task };
                  observeTask(task, message);
                } finally {
                  for (const reserved of changed.values()) reserved.release();
                }
              } else if (message.t === "read") {
                // The selected contribution owns its reader/codec; dispatch has no kind switch.
                try {
                  await publishRead(message, signal);
                } catch (error) {
                  signal.throwIfAborted();
                  post({
                    t: "read.failure",
                    run: run!,
                    id: message.id,
                    outcome: error instanceof OperationFailure &&
                        error.outcome === "rejected"
                      ? "rejected"
                      : "unavailable",
                    failure: {
                      code: error instanceof OperationFailure &&
                          error.outcome !== "unknown"
                        ? error.code
                        : "native.unavailable",
                      retry: error instanceof OperationFailure &&
                          error.outcome === "rejected"
                        ? "new-intent"
                        : "same-intent",
                      diagnosticID: crypto.randomUUID(),
                    },
                  });
                  if (!isCancellation(error)) {
                    post({
                      t: "error",
                      run: run!,
                      id: 0,
                      scope: "worker",
                      message: `Provider read: ${errorMessage(error)}`,
                    });
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
                  await batches!.settle(signal);
                }
                post({ t: "accepted", run: run!, id: message.id });
              } else if (message.t === "transcript") {
                const metadata = await sink!.transcriptMetadata(
                  message.sessionID,
                  message.turns,
                  signal,
                  message.cutoff,
                  message.boundary,
                );
                post({
                  t: "transcript",
                  run: run!,
                  id: message.id,
                  sessionID: message.sessionID,
                  metadata,
                });
              } else if (message.t === "detail") {
                const detail = await sink!.detail(
                  message.sessionID,
                  message.turnID,
                  signal,
                );
                const count = Math.max(
                  1,
                  Math.ceil(
                    detail.calls.length / policy.publishrows,
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
                    turnID: detail.turnID,
                    revision: detail.revision,
                    ...(part === 0 ? { summary: detail.summary } : {}),
                    calls: detail.calls.slice(
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
            },
            signal,
            policy,
            wait,
          ),
      ),
    message.t === "catalog"
      ? "attention"
      : message.t === "read" && message.priority !== "user"
      ? message.priority
      : "interactive",
    message.t === "read",
    message.t === "read" && message.optional === true,
    () => publishing,
  );
  observeTask(task, message);
  kick();
}
function observeTask(task: Promise<unknown>, message: ToWorker): void {
  void task.catch((error) => {
    if (!isCancellation(error)) {
      post({
        t: "error",
        run: run!,
        id: message.id,
        scope: "worker",
        message: errorMessage(error),
      });
    }
  });
}
globalThis.onmessage = ({ data }: MessageEvent<ToWorker>) => handle(data);
