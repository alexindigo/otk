// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import {
  Frecency,
  frecencyMigrations,
  OtkDb,
  Prefs,
  prefsMigrations,
} from "@otk/store";
import {
  type CoreServer,
  frecencyOptions,
  prefsOptions,
  registerAgents,
  registerCommands,
  registerFiles,
  registerFrecency,
  registerHistory,
  registerPermissions,
  registerPrefs,
  registerPrompt,
  registerQuestions,
  registerResources,
  registerRevert,
  registerSessions,
  registerShell,
  RpcRegistry,
  type ServiceConfig,
  startCore,
} from "./core/mod.ts";

/** Shipped application features, independent of the selected native backend. */
export function startApplication(
  cfg: ServiceConfig,
  backend: Harness,
  staticRoot: string,
): Promise<CoreServer> {
  const store = new OtkDb(cfg.state.path, [
    prefsMigrations,
    frecencyMigrations,
  ]);
  const prefs = new Prefs(store, prefsOptions);
  const rpc = new RpcRegistry(backend, store);
  registerPrefs(rpc, backend, prefs);
  registerFrecency(rpc, backend, new Frecency(store, frecencyOptions));
  registerSessions(rpc, backend);
  registerPrompt(rpc, backend);
  registerShell(rpc, backend);
  registerCommands(rpc, backend);
  registerHistory(rpc, backend);
  registerFiles(rpc, backend);
  registerAgents(rpc, backend);
  registerResources(rpc, backend);
  registerPermissions(rpc, backend);
  registerQuestions(rpc, backend);
  registerRevert(rpc, backend);
  return startCore({ cfg, backend, store, prefs, rpc, staticRoot });
}
