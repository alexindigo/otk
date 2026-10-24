// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import {
  Finishes,
  finishesMigrations,
  Frecency,
  frecencyMigrations,
  OtkDb,
  permissionMigrations,
  PermissionStore,
  Prefs,
  prefsMigrations,
  Projects,
  projectsMigrations,
  ProjectTemplates,
  projectTemplatesMigrations,
  Seen,
  seenMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import {
  type CoreServer,
  type FrameSource,
  frecencyOptions,
  IndexStore,
  prefsOptions,
  registerAgents,
  registerCommands,
  registerFiles,
  registerFrecency,
  registerHistory,
  registerLayout,
  registerModels,
  registerPermissions,
  registerPrefs,
  registerPrompt,
  registerQuestions,
  registerResources,
  registerRevert,
  registerSessions,
  registerShell,
  registerUsage,
  RpcRegistry,
  type ServiceConfig,
  startCore,
} from "./core/mod.ts";
import { InboxFeature } from "./core/features/inbox.ts";
import { PermissionFeature } from "./core/features/approvals.ts";

/** Shipped application features, independent of the selected native backend. */
export function startApplication(
  cfg: ServiceConfig,
  backend: Harness,
  staticRoot: string,
): Promise<CoreServer> {
  const store = new OtkDb(cfg.state.path, [
    prefsMigrations,
    frecencyMigrations,
    projectsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
    permissionMigrations,
  ]);
  const sources: FrameSource[] = [];
  try {
    const prefs = new Prefs(store, prefsOptions);
    const rpc = new RpcRegistry(backend, store);
    const index = new IndexStore();
    const inbox = new InboxFeature(
      {
        projects: new Projects(store),
        tasks: new Tasks(store),
        seen: new Seen(store),
        finishes: new Finishes(store),
        templates: new ProjectTemplates(store),
      },
      index,
      () => cfg.auth.username.toLowerCase() || "local",
    );
    sources.push(inbox);
    inbox.register(rpc);
    registerPrefs(rpc, backend, prefs);
    registerLayout(rpc, prefs);
    registerFrecency(rpc, backend, new Frecency(store, frecencyOptions));
    registerSessions(rpc, backend);
    registerPrompt(rpc, backend);
    registerShell(rpc, backend);
    registerCommands(rpc, backend);
    registerHistory(rpc, backend);
    registerFiles(rpc, backend);
    registerAgents(rpc, backend);
    registerModels(rpc, backend);
    registerUsage(rpc, backend);
    registerResources(rpc, backend);
    const approvals = backend.capabilities.permissions
      ? new PermissionFeature(
        new PermissionStore(store),
        index,
        backend.capabilities.permissions,
      )
      : undefined;
    if (approvals) sources.push(approvals);
    approvals?.register(rpc);
    registerPermissions(
      rpc,
      backend,
      approvals && ((input) => approvals.reply(input)),
    );
    registerQuestions(rpc, backend);
    registerRevert(rpc, backend);
    return startCore({
      cfg,
      backend,
      store,
      prefs,
      rpc,
      staticRoot,
      index,
      sources,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    for (const source of sources.reverse()) {
      try {
        source.close?.();
      } catch (failure) {
        failures.push(failure);
      }
    }
    try {
      store.close();
    } catch (failure) {
      failures.push(failure);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Application composition failed", {
        cause: error,
      });
    }
    throw error;
  }
}
