// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import type { OtkDb, Prefs } from "@otk/store";
import type { Preferences } from "@otk/protocol";
import { AuthState } from "./auth/state.ts";
import type { ServiceConfig } from "./config/schema.ts";
import { IndexStore } from "./index/store.ts";
import { Connections } from "./ws/connections.ts";
import type { RpcRegistry } from "./ws/registry.ts";
import { serve } from "./http/server.ts";

export interface CoreOptions {
  cfg: ServiceConfig;
  backend: Harness;
  store: OtkDb;
  prefs: Prefs<Preferences>;
  rpc: RpcRegistry;
  staticRoot: string;
}
export interface CoreServer {
  server: Deno.HttpServer<Deno.NetAddr>;
  backend: Harness;
  index: IndexStore;
  connections: Connections;
  stop(): Promise<void>;
}
/** Application composition supplies a backend, registrations, store and assets. */
export async function startCore(options: CoreOptions): Promise<CoreServer> {
  const { cfg, backend, store, prefs, rpc, staticRoot } = options;
  const auth = new AuthState(cfg), index = new IndexStore();
  const connections = new Connections(
    backend,
    index,
    cfg.harness.url,
    prefs,
    rpc,
  );
  await backend.core.start({
    connection: (state) => connections.connection(state),
    indexReset: (entries) => index.reset(entries),
    indexUpsert: (entry) => index.upsert(entry),
    indexRemove: (id) => index.remove(id),
    content: (id, event) => connections.content(id, event),
    resync: (sessionIDs) => connections.broadcast({ t: "resync", sessionIDs }),
  });
  const server = await serve({ cfg, auth, backend, connections, staticRoot });
  return {
    server,
    backend,
    index,
    connections,
    async stop() {
      connections.close();
      await backend.core.stop();
      await server.shutdown();
      store.close();
    },
  };
}
