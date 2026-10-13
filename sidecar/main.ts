// SPDX-License-Identifier: LGPL-3.0-only
import { config } from "./config/loader.ts";
import { AuthState } from "./auth/state.ts";
import { Opencode1Adapter } from "./adapter/opencode1/adapter.ts";
import { StreamBuffers } from "@otk/content";
import { IndexStore } from "./index/store.ts";
import { Connections } from "./ws/connections.ts";
import { serve } from "./http/server.ts";
import type { ServiceConfig } from "./config/schema.ts";
import { OtkDb } from "./db/db.ts";
import { Prefs } from "./db/prefs.ts";
import { Frecency } from "./db/frecency.ts";
export async function start(cfg: ServiceConfig) {
  if (cfg.harness.type !== "opencode1") {
    throw new Error(`Unsupported harness: ${cfg.harness.type}`);
  }
  const auth = new AuthState(cfg),
    adapter = new Opencode1Adapter(cfg, new StreamBuffers()),
    index = new IndexStore();
  const db = new OtkDb(cfg.state.path), prefs = new Prefs(db);
  const connections = new Connections(
    adapter,
    index,
    cfg.harness.url,
    prefs,
    new Frecency(db),
  );
  await adapter.start({
    connection: (state) => connections.connection(state),
    indexReset: (entries) => index.reset(entries),
    indexUpsert: (entry) => index.upsert(entry),
    indexRemove: (id) => index.remove(id),
    content: (id, event) => connections.content(id, event),
    resync: (sessionIDs) => connections.broadcast({ t: "resync", sessionIDs }),
  });
  const server = await serve({ cfg, auth, adapter, connections });
  return {
    server,
    adapter,
    index,
    connections,
    async stop() {
      connections.close();
      await adapter.stop();
      await server.shutdown();
      db.close();
    },
  };
}
if (import.meta.main) {
  try {
    const app = await start(config());
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.stop();
      Deno.exit();
    };
    Deno.addSignalListener("SIGTERM", stop);
    Deno.addSignalListener("SIGINT", stop);
  } catch (error) {
    console.error((error as Error).message);
    Deno.exit(1);
  }
}
