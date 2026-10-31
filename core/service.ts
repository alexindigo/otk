// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import { type OtkDb, type Prefs, Requests } from "@otk/store";
import type { Preferences } from "@otk/protocol";
import { AuthState } from "./auth/state.ts";
import type { ServiceConfig } from "./config/schema.ts";
import { IndexStore } from "./index/store.ts";
import { Connections } from "./ws/connections.ts";
import type { FrameSource } from "./ws/connections.ts";
import type { RpcRegistry } from "./ws/registry.ts";
import { serve } from "./http/server.ts";
import type { SectionObserver } from "./diagnostics.ts";
import { RequestCoordinator } from "./requests/coordinator.ts";
import { BootstrapRequests } from "./http/bootstrap.ts";
import { clientRequestPolicy } from "./config/schema.ts";

export interface CoreOptions {
  cfg: ServiceConfig;
  backend: Harness;
  store: OtkDb;
  prefs: Prefs<Preferences>;
  rpc: RpcRegistry;
  staticRoot: string;
  index?: IndexStore;
  sources?: readonly FrameSource[];
  diagnostics?: SectionObserver;
}
export interface CoreServer {
  server: Deno.HttpServer<Deno.NetAddr>;
  backend: Harness;
  index: IndexStore;
  connections: Connections;
  requests: RequestCoordinator;
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
    indexReset: (entries) => index.resetMetadata(entries),
    indexUpsert: (entry) => index.upsertMetadata(entry),
    indexRemove: (id) => index.remove(id),
    content: (id, event, clock) => connections.content(id, event, clock),
    bootstrapComplete: () => connections.broadcast({ t: "bootstrap.complete" }),
    invalidate: (value) =>
      connections.broadcast({ t: "transcript.invalidated", ...value }),
  });
}
/** Application composition supplies a backend, registrations, store and assets. */
export async function startCore(options: CoreOptions): Promise<CoreServer> {
  const { cfg, backend, store, prefs, rpc, staticRoot } = options;
  const index = options.index ?? new IndexStore();
  const requests = new RequestCoordinator({
    registry: rpc,
    receipts: new Requests(store),
    policy: cfg.requests,
    diagnostic: (id, cause) => console.warn("request", id, cause),
  });
  let bootstrap: BootstrapRequests | undefined;
  let maintenance: ReturnType<typeof setInterval> | undefined;
  let connections: Connections | undefined,
    server: Deno.HttpServer<Deno.NetAddr> | undefined;
  let backendOwned = false, stopping: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    stopping ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      clearInterval(maintenance);
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
      await attempt(() => requests.stop());
      if (bootstrap) await attempt(() => bootstrap!.stop());
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
      cfg.messages,
      {
        coordinator: requests,
        identity: () => cfg.auth.username.toLowerCase() || "local",
        policy: clientRequestPolicy(cfg),
        helloms: cfg.connection.helloms,
        attachments: cfg.attachments,
      },
      options.sources,
      options.diagnostics,
    );
    backendOwned = true;
    await startBackend(backend, index, transport);
    await requests.start();
    bootstrap = new BootstrapRequests({
      cfg,
      auth,
      backend,
      store,
      window: () => requests.window(),
      diagnostic: (id, cause) => console.warn("bootstrap request", id, cause),
    });
    await bootstrap.start();
    maintenance = setInterval(
      () => requests.maintenance(),
      cfg.requests.livenessms,
    );
    server = await serve({
      cfg,
      auth,
      bootstrap,
      backend,
      connections: transport,
      staticRoot,
    });
    return {
      server,
      backend,
      index,
      connections: transport,
      requests,
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
