// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { OtkDb, Prefs } from "@otk/store";
import type { Preferences } from "@otk/protocol";
import { AuthState } from "./auth/state.ts";
import type { ServiceConfig } from "./config/schema.ts";
import { IndexStore } from "./index/store.ts";
import { Connections } from "./ws/connections.ts";
import type { FrameSource } from "./ws/connections.ts";
import type { RpcRegistry } from "./ws/registry.ts";
import { serve } from "./http/server.ts";

export interface CoreOptions {
  cfg: ServiceConfig;
  backend: Harness;
  store: OtkDb;
  prefs: Prefs<Preferences>;
  rpc: RpcRegistry;
  staticRoot: string;
  index?: IndexStore;
  sources?: readonly FrameSource[];
}
export interface CoreServer {
  server: Deno.HttpServer<Deno.NetAddr>;
  backend: Harness;
  index: IndexStore;
  connections: Connections;
  stop(): Promise<void>;
}
/** Bind the backend to the same authoritative index and live transport. */
function startBackend(
  backend: Harness,
  index: IndexStore,
  connections: Connections,
): Promise<void> {
  return backend.core.start({
    index,
    connection: (state) => connections.connection(state),
    indexReset: (entries) => index.reset(entries),
    indexUpsert: (entry) => index.upsert(entry),
    indexRemove: (id) => index.remove(id),
    content: (id, event) => connections.content(id, event),
    resync: (sessionIDs) => connections.broadcast({ t: "resync", sessionIDs }),
  });
}
/** Application composition supplies a backend, registrations, store and assets. */
export async function startCore(options: CoreOptions): Promise<CoreServer> {
  const { cfg, backend, store, prefs, rpc, staticRoot } = options;
  const index = options.index ?? new IndexStore();
  let connections: Connections | undefined,
    server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let backendOwned = false, stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    stopping ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      const attempt = async (release: () => unknown) => {
        try {
          await release();
        } catch (error) {
          errors.push(error);
        }
      };
      if (connections) await attempt(() => connections!.close());
      else {for (const source of options.sources ?? []) {
          await attempt(() => source.close?.());
        }}
      if (backendOwned) await attempt(() => backend.core.stop());
      if (server) await attempt(() => server!.shutdown());
      await attempt(() => store.close());
      if (errors.length) {
        throw new AggregateError(errors, "Service cleanup failed");
      }
    });
  try {
    const auth = new AuthState(cfg);
    const transport = connections = new Connections(
      backend,
      index,
      cfg.harness.url,
      prefs,
      rpc,
      options.sources,
    );
    backendOwned = true;
    await startBackend(backend, index, transport);
    server = await serve({
      cfg,
      auth,
      backend,
      connections: transport,
      staticRoot,
    });
    return {
      server,
      backend,
      index,
      connections: transport,
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Service startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
