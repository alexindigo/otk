// SPDX-License-Identifier: LGPL-3.0-only
import { isAbsolute, relative, resolve } from "@std/path";
import {
  type DigestPolicy,
  DigestScheduler,
  DirectoryCatalogs,
  ProviderHistory,
  type ProviderReadKinds,
  type ProviderReadOptions,
  type ProviderReadPort,
  ReadAdmission,
} from "@otk/harness";
import type {
  AgentsCapability,
  CatalogDemand,
  CommandOption,
  DirectoryCatalog,
  DirectoryCatalogKinds,
  FilesCapability,
  ModelsCapability,
} from "@otk/protocol";
import type { V2Client } from "./client.ts";
import type { V2Event } from "./stream.ts";
import { catalogReaders, mergeCommands } from "./catalog-readers.ts";

/** Standalone API readers use the existing scheduler. The application injects its worker port. */
export class CatalogExecutor implements ProviderReadPort {
  readonly scheduler: DigestScheduler;
  readonly admission: ReadAdmission;
  #owners = new Map<string, Set<AbortController>>();
  #pump?: Promise<void>;
  #wake = false;
  constructor(
    readonly client: () => V2Client,
    policy: DigestPolicy,
    concurrency: number,
  ) {
    this.scheduler = new DigestScheduler(policy, {
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
    this.admission = new ReadAdmission(
      () => this.scheduler.interruptIO(),
      concurrency,
    );
  }
  #kick(): void {
    this.#wake = true;
    if (this.#pump) return;
    this.#pump = Promise.resolve().then(async () => {
      do {
        this.#wake = false;
        while (await this.scheduler.tick()) { /* bounded turn */ }
      } while (this.#wake);
    }).finally(() => {
      this.#pump = undefined;
      if (this.#wake) this.#kick();
    });
  }
  async read<K extends keyof ProviderReadKinds>(
    kind: K,
    input: ProviderReadKinds[K]["input"],
    options: ProviderReadOptions,
  ): Promise<ProviderReadKinds[K]["result"]> {
    const controller = new AbortController(),
      signal = options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal;
    let owners = this.#owners.get(options.owner);
    if (!owners) this.#owners.set(options.owner, owners = new Set());
    owners.add(controller);
    this.scheduler.requested();
    try {
      return await this.scheduler.execute(
        async (signal, turn) => {
          const release = await turn.wait(
            this.admission.acquire(signal, options.priority === "user"),
            "io",
          );
          let work: Promise<ProviderReadKinds[K]["result"]> | undefined;
          try {
            const reader = catalogReaders(this.client)[kind];
            if (!reader) throw new Error("Provider read not selected");
            work = reader(input, signal);
            return await turn.wait(work, "io");
          } finally {
            if (work) await turn.join(work.then(() => {}, () => {}));
            release();
          }
        },
        signal,
        options.priority === "user" ? "interactive" : options.priority,
        true,
      );
    } finally {
      owners.delete(controller);
      if (!owners.size) this.#owners.delete(options.owner);
    }
  }
  release(owner: string): void {
    for (const controller of this.#owners.get(owner) ?? []) controller.abort();
    this.#owners.delete(owner);
  }
  async stop(): Promise<void> {
    for (const owner of this.#owners.keys()) this.release(owner);
    await this.scheduler.stop();
    await this.#pump;
  }
}
const invalidations: Record<string, readonly (keyof DirectoryCatalogKinds)[]> =
  {
    "agent.updated": ["agents"],
    "command.updated": ["commands"],
    "skill.updated": ["skills"],
    "model.updated": ["models"],
    "provider.updated": ["models"],
    "config.updated": [
      "config",
      "agents",
      "commands",
      "skills",
      "models",
      "resources",
      "resourceTemplates",
    ],
    "mcp.resources.changed": ["resources", "resourceTemplates"],
    "mcp.status.changed": ["resources", "resourceTemplates"],
    "filesystem.changed": ["files"],
  };
export class V2Catalogs {
  readonly catalogs: DirectoryCatalogs;
  readonly history?: ProviderHistory;
  readonly agents: AgentsCapability;
  readonly models: ModelsCapability;
  readonly files: FilesCapability;
  readonly standalone?: CatalogExecutor;
  constructor(
    client: () => V2Client,
    readonly directory: (id: string, signal?: AbortSignal) => Promise<string>,
    policy: DigestPolicy,
    options: { pending: number; concurrency: number },
    diagnostic: (error: unknown) => void,
    reads?: ProviderReadPort,
  ) {
    if (!reads) {
      reads = this.standalone = new CatalogExecutor(
        client,
        policy,
        options.concurrency,
      );
    } else this.history = new ProviderHistory(reads);
    const source = reads;
    this.catalogs = new DirectoryCatalogs(source, {
      pending: options.pending,
      watchFiles: true,
      diagnostic,
      contributions: {
        config: (directory, signal, owner, intent) =>
          source.read("catalog.config", { directory }, {
            owner,
            signal,
            priority: intent === "warm" ? "background" : "user",
          }),
        resourceTemplates: (directory, signal, owner, intent) =>
          source.read("catalog.resourceTemplates", { directory }, {
            owner,
            signal,
            priority: intent === "warm" ? "background" : "user",
          }),
      },
    });
    this.agents = {
      listAgents: async (id, primary = false, signal) =>
        (await this.catalogs.get(await directory(id, signal), "agents", signal))
          .filter((agent) => primary ? agent.primary : agent.mention).map((
            { primary: _primary, mention: _mention, ...agent },
          ) => agent),
    };
    this.models = {
      listModels: async (id, signal) =>
        await this.catalogs.get(await directory(id, signal), "models", signal),
    };
    this.files = {
      findFiles: async (id, query, signal) => {
        const dir = await directory(id, signal),
          values = await this.catalogs.get(dir, "files", signal);
        const search = (isAbsolute(query) ? relative(dir, query) : query)
          .toLowerCase();
        const exact = query
          ? values.find((item) => item.canonicalPath === resolve(dir, query))
          : undefined;
        return [
          ...(exact ? [{ path: query, directory: exact.directory }] : []),
          ...values.filter((item) =>
            item !== exact && item.path.toLowerCase().includes(search)
          ).map(({ path, directory }) => ({ path, directory })),
        ];
      },
    };
  }
  async listCommands(
    id: string,
    signal?: AbortSignal,
  ): Promise<CommandOption[]> {
    const directory = await this.directory(id, signal);
    const [commands, skills] = await Promise.all([
      this.catalogs.get(directory, "commands", signal),
      this.catalogs.get(directory, "skills", signal),
    ]);
    return mergeCommands(commands, skills);
  }
  watch(
    directory: string,
    listener: (value: DirectoryCatalog) => void,
    signal: AbortSignal,
  ): Promise<DirectoryCatalog> {
    signal.throwIfAborted();
    const lease = this.catalogs.acquire(directory, true);
    const release = () => {
      unsubscribe();
      lease.release();
    };
    const unsubscribe = lease.subscribe(() => {
      if (!signal.aborted) listener(lease.snapshot());
    });
    signal.addEventListener("abort", release, { once: true });
    const value = lease.snapshot();
    queueMicrotask(() => {
      if (!signal.aborted) listener(lease.snapshot());
    });
    return Promise.resolve(value);
  }
  demand(
    directory: string,
    demand: CatalogDemand,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.catalogs.demand(directory, demand, signal);
  }
  async refresh(
    directory: string,
    signal?: AbortSignal,
    kinds?: readonly (keyof DirectoryCatalogKinds)[],
  ): Promise<void> {
    signal?.throwIfAborted();
    const lease = this.catalogs.acquire(directory);
    try {
      await lease.refresh(signal, kinds);
      signal?.throwIfAborted();
    } finally {
      lease.release();
    }
  }
  event(event: V2Event): void {
    if (event.type === "location.shutdown") {
      this.catalogs.reset(event.location?.directory);
      return;
    }
    const kinds = invalidations[event.type];
    if (!kinds) return;
    if (event.location?.directory) {
      this.catalogs.invalidate(event.location.directory, kinds);
    } else this.catalogs.invalidateAll(kinds);
  }
  reset(): void {
    this.catalogs.reset();
  }
  async stop(): Promise<void> {
    this.history?.close();
    await this.catalogs.stop();
    await this.standalone?.stop();
  }
}
