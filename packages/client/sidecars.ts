// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory } from "./state.ts";
import {
  type CapabilityName,
  type HarnessState,
  type ServerFrame,
  welcomeCapabilities,
} from "@otk/protocol";
import { apiBase, bootstrapRequestMetadata, normalizeBase } from "./auth.ts";
import {
  createDiscovery,
  type Discovery,
  discoveryFailure,
  type DiscoveryState,
} from "./discovery.ts";
import { FeedbackFailure } from "./failures.ts";
import { HttpRequests } from "./http-requests.ts";
import { reportDiagnostic } from "./diagnostics.ts";
import type { PublicDefaults } from "./public-defaults.ts";
import {
  type ConnectionOptions,
  type ConnectionState,
  SidecarConnection,
} from "./connection.ts";

export interface SidecarSpec {
  id: string;
  baseUrl: string;
  label: string;
}
export interface SidecarState extends SidecarSpec {
  status: ConnectionState;
  harness: HarnessState;
  error?: string;
  authType?: string;
  capabilities: CapabilityName[];
  /** Changes on each welcomed transport connection, including reconnects. */
  connectionVersion?: number;
  defaults?: PublicDefaults;
}
export const LOCAL_SIDECAR = "local";
export function readSidecars(
  storage: Pick<Storage, "getItem">,
  report: (error: unknown) => void = (error) =>
    console.error("Saved sidecar configuration rejected", error),
): SidecarSpec[] {
  const implicit = { id: LOCAL_SIDECAR, baseUrl: "", label: "This server" };
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem("otk.sidecars") || "[]");
    if (!Array.isArray(raw)) throw new Error("Expected a saved sidecar array");
  } catch (error) {
    reportDiagnostic(report, error);
    return [implicit];
  }
  const seen = new Set([LOCAL_SIDECAR]), urls = new Set<string>();
  const remote: SidecarSpec[] = [];
  for (const [index, item] of raw.entries()) {
    try {
      if (
        !item || typeof item !== "object" ||
        typeof item.id !== "string" || !item.id || item.id.includes("/") ||
        typeof item.label !== "string" || typeof item.baseUrl !== "string" ||
        !item.baseUrl || seen.has(item.id)
      ) throw new Error("Invalid or duplicate saved sidecar");
      const baseUrl = normalizeBase(item.baseUrl);
      if (urls.has(baseUrl)) throw new Error("Duplicate saved sidecar URL");
      seen.add(item.id);
      urls.add(baseUrl);
      remote.push({ id: item.id, baseUrl, label: item.label });
    } catch (error) {
      reportDiagnostic(
        report,
        new Error(`Invalid saved sidecar entry ${index}`, {
          cause: error,
        }),
      );
    }
  }
  return [implicit, ...remote];
}
export interface SidecarsOptions {
  storage?: Pick<Storage, "getItem" | "setItem">;
  connection?: ConnectionOptions;
  diagnostic?: (error: unknown) => void;
  discoveryFetch?: typeof fetch;
}
export interface SidecarsState {
  list: SidecarState[];
  discovery?: DiscoveryState;
}
export interface ClientSidecars {
  state: SidecarsState;
  subscribe(listener: (state: SidecarsState) => void): () => void;
  connection(id: string): SidecarConnection;
  start(): void;
  stop(): void;
  add(value: string, label: string): Promise<string>;
  cancelAdd?(): Promise<void>;
  remove(id: string): void;
}
export function createSidecars(
  onFrame: (id: string, frame: ServerFrame) => boolean | void,
  options: SidecarsOptions = {},
  factory: StateFactory = createState,
): ClientSidecars {
  const storage = options.storage ?? globalThis.localStorage;
  const initial = readSidecars(storage, options.diagnostic);
  const { state, update: setState, subscribe } = factory<SidecarsState>({
    list: initial.map((item) => ({
      ...item,
      status: "connecting",
      harness: "connecting",
      capabilities: [],
    })),
  });
  const connections = new Map<string, SidecarConnection>();
  const specs = new Map(initial.map((spec) => [spec.id, spec]));
  const additions = new Map<
    string,
    { owner: Discovery; work: Promise<string> }
  >();
  let currentDiscovery: Discovery | undefined;
  let stopped = false;
  const rejected = (target: string, reason: string, next: string) => {
    const failure = discoveryFailure(target, reason, next);
    setState((draft) => {
      draft.discovery = {
        target,
        pending: false,
        steps: [{
          key: "connecting",
          label: "Connecting",
          elapsedMs: 0,
          result: { kind: "error", text: failure.feedback.text },
        }],
      };
    });
    return Promise.reject(failure);
  };
  const persist = () =>
    storage.setItem(
      "otk.sidecars",
      JSON.stringify(
        [...specs.values()].filter((spec) => spec.id !== LOCAL_SIDECAR),
      ),
    );
  const install = (spec: SidecarSpec) => {
    const connection = new SidecarConnection(
      spec.baseUrl,
      {
        defaults(value) {
          setState((draft) => {
            const item = draft.list.find((item) => item.id === spec.id);
            if (item) item.defaults = value;
          });
        },
        status(status, error, authType) {
          setState((draft) => {
            const item = draft.list.find((item) => item.id === spec.id);
            if (item) {
              item.status = status;
              if (status === "connected") {
                item.connectionVersion = (item.connectionVersion ?? 0) + 1;
              }
              // Capabilities describe the backend, not transport liveness. Keep
              // feature owners (and their unsent input) mounted while reconnecting.
              item.error = error;
              if (authType !== undefined) item.authType = authType;
            }
          });
        },
        frame(frame) {
          if (frame.t === "welcome") {
            setState((draft) => {
              const item = draft.list.find((item) => item.id === spec.id);
              if (item) {
                item.capabilities = [...welcomeCapabilities(frame)];
              }
            });
          }
          if (frame.t === "harness") {
            setState((draft) => {
              const item = draft.list.find((item) => item.id === spec.id);
              if (item) item.harness = frame.state;
            });
          }
          return onFrame(spec.id, frame);
        },
      },
      spec.id === LOCAL_SIDECAR
        ? options.connection
        : { afterRender: options.connection?.afterRender },
    );
    connections.set(spec.id, connection);
  };
  for (const item of initial) install(item);
  return {
    state,
    subscribe,
    connection(id: string): SidecarConnection {
      const connection = connections.get(id);
      if (!connection) throw new Error("Unknown sidecar");
      return connection;
    },
    start(): void {
      if (stopped) return;
      for (const connection of connections.values()) void connection.connect();
    },
    stop(): void {
      stopped = true;
      for (const addition of additions.values()) void addition.owner.cancel();
      for (const connection of connections.values()) connection.stop();
    },
    add(value: string, label: string): Promise<string> {
      if (stopped) {
        return rejected(
          "the entered address",
          "the server collection has stopped",
          "Reload OTK before adding a server",
        );
      }
      let baseUrl: string;
      try {
        baseUrl = normalizeBase(value);
      } catch {
        return rejected(
          "the entered address",
          "it is not an HTTP(S) base URL without credentials, query or fragment",
          "Enter the other computer's OTK base URL",
        );
      }
      if ([...specs.values()].some((item) => item.baseUrl === baseUrl)) {
        return rejected(
          baseUrl,
          "this server is already added",
          "Use its existing server card",
        );
      }
      const pending = additions.get(baseUrl);
      if (pending) return pending.work;
      const base = apiBase(baseUrl);
      const http = new HttpRequests({
        base,
        fetcher: options.discoveryFetch,
        kind: (method) => bootstrapRequestMetadata[method]?.kind ?? "mutation",
      });
      const owner = createDiscovery({
        base,
        fetcher: options.discoveryFetch,
        signIn: (signal) => http.read("session", { signal }),
      });
      currentDiscovery = owner;
      const publish = () => {
        if (currentDiscovery === owner) {
          setState((draft) => {
            draft.discovery = {
              ...owner.state,
              steps: owner.state.steps.map((step) => ({ ...step })),
            };
          });
        }
      };
      const release = owner.subscribe(publish);
      const deferred = Promise.withResolvers<string>();
      // Reserve the URL and cancellation owner before publishing any step.
      additions.set(baseUrl, { owner, work: deferred.promise });
      const work = owner.start().then(async (result) => {
        if ("feedback" in result) {
          throw new FeedbackFailure(result.feedback);
        }
        if (stopped) throw new Error("Sidecar collection is stopped");
        const spec = {
          id: crypto.randomUUID(),
          baseUrl,
          label: label.trim() || new URL(baseUrl).host,
        };
        specs.set(spec.id, spec);
        install(spec);
        setState((draft) => {
          draft.list.push({
            ...spec,
            status: "connecting",
            harness: "connecting",
            capabilities: [],
          });
        });
        queueMicrotask(persist);
        await connections.get(spec.id)?.connect(result.auth);
        return spec.id;
      }).finally(async () => {
        release();
        await http.stop();
        if (additions.get(baseUrl)?.owner === owner) {
          additions.delete(baseUrl);
        }
      });
      void work.then(deferred.resolve, deferred.reject);
      return deferred.promise;
    },
    async cancelAdd() {
      const owner = currentDiscovery;
      const addition = [...additions.values()].find((entry) =>
        entry.owner === owner
      );
      await owner?.cancel();
      await addition?.work.catch(() => {});
    },
    remove(id: string): void {
      if (id === LOCAL_SIDECAR) return;
      connections.get(id)?.stop();
      connections.delete(id);
      specs.delete(id);
      setState((draft) => {
        draft.list = draft.list.filter((item) => item.id !== id);
      });
      queueMicrotask(persist);
    },
  };
}
