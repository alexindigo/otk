// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import { OtkDb, Prefs, prefsMigrations } from "@otk/store";
import {
  type CoreServer,
  prefsOptions,
  registerPrefs,
  registerPrompt,
  registerSessions,
  RpcRegistry,
  type ServiceConfig,
  startCore,
} from "./mod.ts";

/** Alternate application composition using a supplied backend and assets. */
export function serveBackend(
  backend: Harness,
  cfg: ServiceConfig,
  staticRoot: string,
): Promise<CoreServer> {
  const store = new OtkDb(cfg.state.path, prefsMigrations);
  const prefs = new Prefs(store, prefsOptions),
    rpc = new RpcRegistry(backend, store);
  registerSessions(rpc, backend);
  registerPrompt(rpc, backend); // No prompt RPCs when this capability is absent.
  registerPrefs(rpc, backend, prefs);
  return startCore({ cfg, backend, store, prefs, rpc, staticRoot });
}
