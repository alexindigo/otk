// SPDX-License-Identifier: LGPL-3.0-only
import {
  type DigestPolicy,
  DigestScheduler,
  type ProviderReaders,
  type ProviderReadKinds,
  type ProviderReadOptions,
  type ProviderReadPort,
  ReadAdmission,
} from "@otk/harness";
import { Client } from "./client.ts";
import { harnessDb, type OpencodeV1Config } from "./config.ts";
import { HistoryDatabase } from "./history.ts";
import { catalogReaders } from "./catalog-reads.ts";

/** Standalone integrations inject the same scheduler policy; no derived DB is needed. */
export class CatalogExecutor implements ProviderReadPort {
  #scheduler?: DigestScheduler;
  #owners = new Map<string, Set<AbortController>>();
  #pump?: Promise<void>;
  #wake = false;
  constructor(
    readonly cfg: OpencodeV1Config,
    readonly policy: DigestPolicy,
    readonly concurrency: number,
    readonly statconcurrency: number,
    readonly fetcher = fetch,
  ) {}
  #start(): DigestScheduler {
    if (!this.#scheduler) {
      const scheduler = new DigestScheduler(this.policy, {
        freeMemory: () => Deno.systemMemoryInfo().available,
        sleep: (ms, signal) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, ms);
            const abort = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          }),
        wake: () => this.#kick(),
      });
      this.#scheduler = scheduler;
    }
    return this.#scheduler;
  }
  #kick(): void {
    this.#wake = true;
    if (this.#pump) return;
    this.#pump = Promise.resolve().then(async () => {
      do {
        this.#wake = false;
        while (await this.#scheduler?.tick()) {
          /* one bounded scheduler turn */
        }
      } while (this.#wake);
    }).finally(() => {
      this.#pump = undefined;
      if (this.#wake) this.#kick();
    });
  }
  #admission?: ReadAdmission;
  #metadata?: ReadAdmission;
  #history?: HistoryDatabase;
  async read<K extends keyof ProviderReadKinds>(
    kind: K,
    input: ProviderReadKinds[K]["input"],
    options: ProviderReadOptions,
  ): Promise<ProviderReadKinds[K]["result"]> {
    const scheduler = this.#start();
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    let owned = this.#owners.get(options.owner);
    if (!owned) this.#owners.set(options.owner, owned = new Set());
    owned.add(controller);
    const admission = this.#admission ??= new ReadAdmission(
      () => scheduler.interruptIO(),
      this.concurrency,
    );
    try {
      return await scheduler.execute(
        async (signal, execution) => {
          const client = new Client(
            this.cfg.harness,
            this.fetcher,
            (value, join) =>
              join ? execution.join(value) : execution.wait(value, "io"),
            (signal) => admission.acquire(signal, options.priority === "user"),
          );
          const metadata = this.#metadata ??= new ReadAdmission(
            undefined,
            this.statconcurrency,
          );
          const history = this.#history ??= new HistoryDatabase(
            harnessDb(this.cfg),
          );
          const readers: ProviderReaders = {
            ...catalogReaders(
              client,
              (signal) => metadata.acquire(signal, options.priority === "user"),
            ),
            ...history.reader(
              this.cfg.attachments,
              () =>
                execution.wait(
                  new Promise((resolve) => setTimeout(resolve, 0)),
                ),
            ).readers(),
          };
          const reader = readers[kind];
          if (!reader) throw new Error("Provider read not selected");
          return await reader(input, signal);
        },
        signal,
        options.priority === "user" ? "interactive" : options.priority,
        true,
      );
    } finally {
      owned.delete(controller);
      if (!owned.size && this.#owners.get(options.owner) === owned) {
        this.#owners.delete(options.owner);
      }
    }
  }
  release(owner: string): void {
    for (const controller of this.#owners.get(owner) ?? []) controller.abort();
    this.#owners.delete(owner);
  }
  async stop(): Promise<void> {
    for (const owner of this.#owners.keys()) this.release(owner);
    await this.#scheduler?.stop();
    await this.#pump;
    this.#scheduler = undefined;
    this.#admission = undefined;
    this.#metadata = undefined;
    this.#history?.close();
    this.#history = undefined;
  }
}
