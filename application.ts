// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import {
  Checkouts,
  checkoutsMigrations,
  Finishes,
  finishesMigrations,
  Frecency,
  frecencyMigrations,
  OtkDb,
  permissionMigrations,
  PermissionStore,
  pluginStorageMigrations,
  PluginStore,
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
  FormsFeature,
  type FrameSource,
  frecencyOptions,
  IndexStore,
  prefsOptions,
  registerAgents,
  registerCommands,
  registerFiles,
  registerForms,
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
  registerSource,
  registerUsage,
  RpcRegistry,
  type ServiceConfig,
  startCore,
} from "./core/mod.ts";
import { InboxFeature } from "./core/features/inbox.ts";
import { PermissionFeature } from "./core/features/approvals.ts";
import { RequestAttention } from "./core/features/request-attention.ts";
import { registerDigests } from "./core/features/digests.ts";
import { NavigationDefault } from "./core/features/navigation-default.ts";
import {
  createCatalogCodecs,
  registerCatalogs,
} from "./core/features/catalogs.ts";
import type { SectionObserver } from "./core/diagnostics.ts";

/** Shipped application features, independent of the selected native backend. */
export async function startApplication(
  cfg: ServiceConfig,
  backend: Harness,
  staticRoot: string,
  options: {
    upgrade?: (store: OtkDb) => void | Promise<void>;
    index?: IndexStore;
    interactive?: (owner: string, active: boolean) => void;
    requested?: () => void;
    attention?: (sessionID: string) => void;
    discoveryProject?: (directory: string, active: boolean) => void;
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
    checkoutsMigrations,
    tasksMigrations,
    seenMigrations,
    finishesMigrations,
    projectTemplatesMigrations,
    permissionMigrations,
    sessionReferenceMigrations,
    requestsMigrations,
    pluginStorageMigrations,
  ], cfg.storage);
  const sources: FrameSource[] = [...options.sources ?? []];
  try {
    options.signal?.throwIfAborted();
    await options.upgrade?.(store);
    backend.storage?.(new PluginStore(store).scope(backend.core.kind));
    options.signal?.throwIfAborted();
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
        checkouts: new Checkouts(store),
      },
      index,
      () => cfg.auth.username.toLowerCase() || "local",
      undefined,
      options.attention,
      cfg.digest.publishrows,
      cfg.digest.maxpending,
      backend.core.hydrate,
      options.discoveryProject,
    );
    sources.push(inbox);
    inbox.register(rpc);
    registerPrefs(rpc, backend, prefs);
    registerLayout(
      rpc,
      prefs,
      new NavigationDefault({
        hierarchy: index.hierarchy,
        scopes: (directory) =>
          inbox.summaries.values.get(directory)?.scopes ?? [directory],
        entries: (directory) => index.catalog(directory),
        status: (id) => inbox.navigationStatus(id),
      }),
    );
    sources.push(
      registerFrecency(rpc, backend, new Frecency(store, frecencyOptions)),
    );
    registerSessions(
      rpc,
      backend,
      (directory, tx) => inbox.activate(directory, tx),
      cfg.digest.publishrows,
      index.hierarchy,
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
    registerSource(rpc, backend);
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
        return entry.attention.permissions;
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
    registerForms(rpc, backend);
    if (backend.capabilities.forms) {
      const forms = new FormsFeature(
        backend.capabilities.forms,
        options.diagnostic ?? console.error,
      );
      sources.push(forms);
      inbox.locationAttention(
        () => forms.locations(),
        (changed) => forms.listen(() => changed()),
      );
    }
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
