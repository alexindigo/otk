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
  requestsMigrations,
  Seen,
  seenMigrations,
  sessionReferenceMigrations,
  Tasks,
  tasksMigrations,
} from "@otk/store";
import {
  type CoreServer,
  type DiagnosticSink,
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
  registerSessionActions,
  registerSessions,
  registerShell,
  registerUsage,
  RpcRegistry,
  type ServiceConfig,
  startCore,
} from "./core/mod.ts";
import { InboxFeature } from "./core/features/inbox.ts";
import { PermissionFeature } from "./core/features/approvals.ts";
import { RequestAttention } from "./core/features/request-attention.ts";
import { registerDigests } from "./core/features/digests.ts";
import {
  createCatalogCodecs,
  registerCatalogs,
} from "./core/features/catalogs.ts";
import type { SectionObserver } from "./core/diagnostics.ts";

/** Shipped application features, independent of the selected native backend. */
export function startApplication(
  cfg: ServiceConfig,
  backend: Harness,
  staticRoot: string,
  options: {
    upgrade?: (store: OtkDb) => void;
    index?: IndexStore;
    interactive?: (owner: string, active: boolean) => void;
    requested?: () => void;
    attention?: (sessionID: string) => void;
    diagnostics?: SectionObserver;
    diagnostic?: DiagnosticSink;
    signal?: AbortSignal;
    sources?: readonly FrameSource[];
  } = {},
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
    sessionReferenceMigrations,
    requestsMigrations,
  ], cfg.storage);
  const sources: FrameSource[] = [...options.sources ?? []];
  try {
    options.upgrade?.(store);
    const prefs = new Prefs(store, prefsOptions);
    const index = options.index ?? new IndexStore();
    const rpc = new RpcRegistry(
      backend,
      store,
      options.interactive,
      (id) => index.getMetadata(id),
    );
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
      undefined,
      options.attention,
      cfg.digest.publishrows,
      cfg.digest.maxpending,
      backend.core.hydrate,
    );
    sources.push(inbox);
    inbox.register(rpc);
    registerPrefs(rpc, backend, prefs);
    registerLayout(rpc, prefs);
    sources.push(
      registerFrecency(rpc, backend, new Frecency(store, frecencyOptions)),
    );
    registerSessions(
      rpc,
      backend,
      (directory, tx) => inbox.activate(directory, tx),
      cfg.digest.publishrows,
    );
    registerSessionActions(
      rpc,
      backend,
      (directory, tx) => inbox.activate(directory, tx),
    );
    registerPrompt(rpc, backend);
    registerShell(rpc, backend);
    registerCommands(rpc, backend);
    registerHistory(rpc, backend);
    registerFiles(rpc, backend);
    registerAgents(rpc, backend);
    registerModels(rpc, backend);
    registerUsage(rpc, backend);
    registerDigests(rpc, backend);
    registerCatalogs(
      rpc,
      backend,
      createCatalogCodecs(),
      cfg.digest.publishrows,
    );
    registerResources(rpc, backend);
    const approvals = backend.capabilities.permissions
      ? new PermissionFeature(
        new PermissionStore(store),
        index,
        backend.capabilities.permissions,
      )
      : undefined;
    if (approvals) sources.push(approvals);
    sources.push(new RequestAttention(index, (id) => !!approvals?.owner(id)));
    if (approvals) {
      inbox.approvalAttention((id) => {
        const entry = index.getMetadata(id);
        if (!entry || approvals.owner(id)) return 0;
        let count = entry.attention.permissions +
          entry.attention.childPermissions;
        if (!entry.attention.childPermissions) return count;
        for (const childID of index.descendants(id)) {
          if (childID === id) continue;
          const child = index.getMetadata(childID);
          if (
            !child || !approvals.owner(childID) ||
            child.parentID && approvals.owner(child.parentID)
          ) continue;
          count -= child.attention.permissions +
            child.attention.childPermissions;
        }
        return Math.max(0, count);
      }, (changed) =>
        approvals.listen((frame) => {
          if (frame.t === "approvals") changed();
        }));
    }
    approvals?.register(rpc);
    registerPermissions(
      rpc,
      backend,
      approvals && ((input, operation) => approvals.reply(input, operation)),
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
      diagnostics: options.diagnostics,
      diagnostic: options.diagnostic,
      signal: options.signal,
      requested: options.requested,
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
