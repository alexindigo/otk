// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContentSession,
  type IndexEntry,
  isSessionID,
  type ServerFrame,
} from "@otk/protocol";
import type { SidecarConnection } from "./connection.ts";
import type { IndexChanges } from "./index.ts";
import type { DirectoryCatalogLease } from "./directory-catalogs.ts";
import type { FrecencyCatalogLease } from "./frecency-catalogs.ts";
import { createState, type StateFactory } from "./state.ts";
import { emptyContent } from "./reduce.ts";
import {
  createModelCatalog,
  type ModelCatalogConnection,
  type ModelCatalogOwner,
} from "./model-catalog.ts";
import { createSessionUsage, type SessionUsageOwner } from "./session-usage.ts";
import {
  createTranscripts,
  type TranscriptDemand,
  type TranscriptsOwner,
} from "./transcripts.ts";
import type {
  ToolPart,
  TranscriptOwner,
  TranscriptState,
} from "./transcript.ts";
export type { ToolCompletionSource, ToolPart } from "./transcript.ts";

export interface Selection {
  sidecarId: string;
  sessionID: string;
  rootID?: string;
}
export function route(hash: string): Selection | undefined {
  const parts = hash.match(/^#\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (!parts) return;
  try {
    const sessionID = decodeURIComponent(parts[3] || parts[2]);
    const rootID = parts[3] ? decodeURIComponent(parts[2]) : undefined;
    if (
      !isSessionID(sessionID) || (rootID !== undefined && !isSessionID(rootID))
    ) return;
    return {
      sidecarId: decodeURIComponent(parts[1]),
      sessionID,
      ...(rootID ? { rootID } : {}),
    };
  } catch {
    return;
  }
}
export function hashFor(selection: Selection): string {
  return `#/${encodeURIComponent(selection.sidecarId)}/${
    selection.rootID ? encodeURIComponent(selection.rootID) + "/" : ""
  }${encodeURIComponent(selection.sessionID)}`;
}
export type SessionState = Pick<
  TranscriptState,
  | "view"
  | "catalogReady"
  | "deleted"
  | "selection"
  | "info"
  | "clock"
  | "latestPrompt"
  | "siblings"
  | "content"
  | "loading"
  | "paging"
  | "exhausted"
  | "continuity"
  | "error"
>;
export interface ClientSession {
  state: SessionState;
  readonly models: ModelCatalogOwner | undefined;
  readonly directoryCatalog: DirectoryCatalogLease | undefined;
  readonly frecencyCatalog: FrecencyCatalogLease | undefined;
  readonly usage: SessionUsageOwner;
  readonly transcripts: TranscriptsOwner;
  readonly transcript: TranscriptOwner | undefined;
  subscribe(listener: (state: SessionState) => void): () => void;
  onToolCompleted(
    selection: Selection,
    listener: (part: ToolPart) => void,
  ): () => void;
  open(selection?: Selection): void;
  demand(value: TranscriptDemand): void;
  refetch(): Promise<void>;
  receive(sidecarId: string, frame: ServerFrame): void;
  removeServer(sidecarId: string): void;
  older(): Promise<void>;
  latestPrompt(): TranscriptState["latestPrompt"];
  stop(): void;
}
/** The selected session is a facade over the canonical collection, never a body cache. */
export function createSession(
  connection: (id: string) => SidecarConnection,
  entry: (sidecarId: string, id: string) => IndexEntry | undefined,
  factory: StateFactory = createState,
  catalogConnection?: (selection: Selection) => ModelCatalogConnection,
  waitForIndex = false,
  metadataChanges?: (server: string) => IndexChanges | undefined,
  catalogs?: (
    target: Selection,
    directory: string,
  ) =>
    | { directory: DirectoryCatalogLease; frecency: FrecencyCatalogLease }
    | undefined,
): ClientSession {
  const store = factory<SessionState>({
    content: emptyContent(),
    siblings: [],
    loading: false,
    paging: false,
    exhausted: false,
    continuity: "ready",
    view: "content",
  });
  const usage = createSessionUsage(
    connection,
    factory,
    (t) => entry(t.sidecarId, t.sessionID),
  );
  const transcripts = createTranscripts({
    connection,
    entry,
    factory,
    changes: metadataChanges,
  });
  let selected: Selection | undefined, resource: TranscriptOwner | undefined;
  let release: (() => void) | undefined, models: ModelCatalogOwner | undefined;
  let catalog: ReturnType<NonNullable<typeof catalogs>>,
    catalogPath: string | undefined;
  const releaseCatalog = () => {
    catalog?.directory.release();
    catalog?.frecency.release();
    catalog = undefined;
    catalogPath = undefined;
  };
  let external: TranscriptDemand | undefined, version = 0, stopped = false;
  const indexed = new Set<string>();
  const sync = () => {
    const data = selected && entry(selected.sidecarId, selected.sessionID);
    const deleted = data?.deleted;
    store.update((draft) => {
      draft.selection = selected;
      draft.catalogReady = !selected || !waitForIndex ||
        indexed.has(selected.sidecarId) || !!data;
      draft.view = deleted ? "deleted" : "content";
      draft.deleted = deleted ? data : undefined;
      if (deleted) {
        draft.info = {
          id: data.id,
          directory: data.directory,
          projectID: data.projectID,
          title: data.title,
          parentID: data.parentID,
          archived: data.archived,
          time: { created: data.timeCreated, updated: data.timeUpdated },
        } as ContentSession;
        draft.content = emptyContent();
        draft.loading = false;
        draft.paging = false;
        draft.exhausted = true;
        draft.continuity = "ready";
        draft.clock = undefined;
        draft.latestPrompt = undefined;
        draft.error = undefined;
        draft.siblings = [];
      } else if (resource) {
        const value = resource.state;
        draft.info = value.info;
        draft.clock = value.clock;
        draft.latestPrompt = value.latestPrompt;
        draft.content = value.content;
        draft.siblings = value.siblings;
        draft.loading = value.loading;
        draft.paging = value.paging;
        draft.exhausted = value.exhausted;
        draft.continuity = value.continuity;
        draft.error = value.error;
      } else {
        draft.info = undefined;
        draft.clock = undefined;
        draft.latestPrompt = undefined;
        draft.content = emptyContent();
        draft.siblings = [];
        draft.loading = !!selected;
        draft.paging = false;
        draft.exhausted = false;
        draft.continuity = selected ? "loading" : "ready";
        draft.error = undefined;
      }
    });
  };
  const bind = () => {
    if (stopped) return;
    const data = selected && entry(selected.sidecarId, selected.sessionID);
    const ready = selected && !data?.deleted &&
      (!waitForIndex || indexed.has(selected.sidecarId) || data);
    if (!ready) {
      models?.dispose();
      models = undefined;
      releaseCatalog();
    }
    const value = external
      ? { ...external, selected: ready ? external.selected : undefined }
      : {
        scope: selected
          ? {
            sidecarId: selected.sidecarId,
            directory: data?.directory ?? `session:${selected.sessionID}`,
          }
          : undefined,
        sessions: ready ? [selected!] : [],
        selected: ready ? selected : undefined,
      };
    transcripts.setDemand(value);
    const next = selected ? transcripts.get(selected) : undefined;
    if (next !== resource) {
      release?.();
      resource?.selected(false);
      resource = next;
      release = resource?.subscribe(sync);
    }
    resource?.selected(!!ready);
    if (ready && data?.directory && data.directory !== catalogPath) {
      releaseCatalog();
      catalog = catalogs?.(selected!, data.directory);
      catalogPath = data.directory;
    }
    if (ready && !models) {
      const target = selected!, sidecar = connection(target.sidecarId);
      models = catalog?.directory.view("models") ?? createModelCatalog({
        connection: () =>
          catalogConnection?.(target) ??
            {
              key: version,
              connected: sidecar.supports("models"),
              available: sidecar.supports("models"),
            },
        load: async (signal) => {
          // Speculative catalogs cannot occupy native I/O ahead of the captured
          // selection's essential first attempt. A failed attempt also releases it.
          signal.throwIfAborted();
          const initial = transcripts.get(target);
          if (initial?.state.loading) {
            await new Promise<void>((resolve, reject) => {
              let release = () => {};
              const cleanup = () => {
                release();
                signal.removeEventListener("abort", abort);
              };
              const abort = () => {
                cleanup();
                reject(signal.reason);
              };
              const check = () => {
                if (!initial.state.loading) {
                  cleanup();
                  resolve();
                }
              };
              release = initial.subscribe(check);
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
              else check();
            });
          }
          signal.throwIfAborted();
          return await sidecar.rpc.call(
            "models.list",
            { sessionID: target.sessionID },
            signal,
          );
        },
        factory,
      });
      models.connect();
    }
    sync();
  };
  const open = (value?: Selection) => {
    if (
      stopped ||
      (value?.sidecarId === selected?.sidecarId &&
        value?.sessionID === selected?.sessionID)
    ) return;
    release?.();
    resource?.selected(false);
    release = undefined;
    resource = undefined;
    models?.dispose();
    models = undefined;
    releaseCatalog();
    selected = value;
    // The shell replaces scope demand through its binding; standalone consumers use a selected scope.
    if (external) external = { ...external, selected: value };
    bind();
  };
  return {
    state: store.state,
    usage,
    transcripts,
    get transcript() {
      return resource;
    },
    get models() {
      void store.state.selection;
      return models;
    },
    get directoryCatalog() {
      void store.state.selection;
      return catalog?.directory;
    },
    get frecencyCatalog() {
      void store.state.selection;
      return catalog?.frecency;
    },
    subscribe: store.subscribe,
    onToolCompleted: (target, listener) =>
      resource?.onToolCompleted(target, listener) ?? (() => {}),
    open,
    demand(value) {
      external = value;
      bind();
    },
    refetch: () => resource?.refetch() ?? Promise.resolve(),
    older: () => resource?.older() ?? Promise.resolve(),
    latestPrompt: () => resource?.latestPrompt(),
    receive(server, frame) {
      if (stopped) return;
      usage.receive(server, frame);
      if (frame.t === "welcome") {
        indexed.delete(server);
        if (selected?.sidecarId === server) version++;
      }
      if (frame.t === "index.snapshot") indexed.add(server);
      transcripts.receive(server, frame, true);
      if (frame.t === "welcome") bind();
      if (frame.t === "index.snapshot" || frame.t === "index.patch") {
        const reduced = metadataChanges?.(server);
        const changes = reduced?.revision === frame.rev ? reduced : undefined;
        if (!changes || changes.structural) bind();
        else if (
          selected?.sidecarId === server &&
          changes.ids.includes(selected.sessionID)
        ) sync();
      }
      if (
        selected?.sidecarId === server &&
        (frame.t === "welcome" || frame.t === "bootstrap.complete")
      ) {
        models?.connect();
        // Borrowed directory views own their native invalidations. Only the
        // standalone catalog created here is refreshed by this facade.
        if (frame.t === "bootstrap.complete" && !catalog) {
          void models?.refresh();
        }
      }
    },
    removeServer(server) {
      indexed.delete(server);
      usage.removeServer(server);
      if (selected?.sidecarId === server) open();
      transcripts.removeServer(server);
    },
    stop() {
      if (stopped) return;
      open();
      stopped = true;
      release?.();
      models?.dispose();
      transcripts.stop();
      usage.stop();
    },
  };
}
