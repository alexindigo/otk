// SPDX-License-Identifier: LGPL-3.0-only
import { createStore } from "solid-js";
import type { HarnessState, ServerFrame } from "../../../protocol/messages.ts";
import { apiBase, normalizeBase, request } from "../net/auth.ts";
import { type ConnectionState, SidecarConnection } from "../net/sidecar.ts";

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
}
export const LOCAL_SIDECAR = "local";
export function readSidecars(storage: Pick<Storage, "getItem">): SidecarSpec[] {
  const implicit = { id: LOCAL_SIDECAR, baseUrl: "", label: "This sidecar" };
  try {
    const raw = JSON.parse(storage.getItem("otk.sidecars") || "[]");
    if (!Array.isArray(raw)) return [implicit];
    const seen = new Set([LOCAL_SIDECAR]), urls = new Set<string>();
    const remote: SidecarSpec[] = [];
    for (const item of raw) {
      if (
        typeof item.id !== "string" || !item.id || item.id.includes("/") ||
        typeof item.label !== "string" || typeof item.baseUrl !== "string" ||
        !item.baseUrl || seen.has(item.id)
      ) continue;
      const baseUrl = normalizeBase(item.baseUrl);
      if (urls.has(baseUrl)) continue;
      seen.add(item.id);
      urls.add(baseUrl);
      remote.push({ id: item.id, baseUrl, label: item.label });
    }
    return [implicit, ...remote];
  } catch {
    return [implicit];
  }
}
export function createSidecars(
  onFrame: (id: string, frame: ServerFrame) => void,
) {
  const initial = readSidecars(localStorage);
  const [state, setState] = createStore<{ list: SidecarState[] }>({
    list: initial.map((item) => ({
      ...item,
      status: "connecting",
      harness: "connecting",
    })),
  });
  const connections = new Map<string, SidecarConnection>();
  const persist = () =>
    localStorage.setItem(
      "otk.sidecars",
      JSON.stringify(
        [...connections.keys()].filter((id) => id !== LOCAL_SIDECAR).map(
          (id) => {
            const item = state.list.find((item) => item.id === id)!;
            return { id: item.id, baseUrl: item.baseUrl, label: item.label };
          },
        ),
      ),
    );
  const install = (spec: SidecarSpec) => {
    const connection = new SidecarConnection(spec.baseUrl, {
      status(status, error, authType) {
        setState((draft) => {
          const item = draft.list.find((item) => item.id === spec.id);
          if (item) {
            item.status = status;
            item.error = error;
            if (authType !== undefined) item.authType = authType;
          }
        });
      },
      frame(frame) {
        if (frame.t === "harness") {
          setState((draft) => {
            const item = draft.list.find((item) => item.id === spec.id);
            if (item) item.harness = frame.state;
          });
        }
        onFrame(spec.id, frame);
      },
    });
    connections.set(spec.id, connection);
  };
  for (const item of initial) install(item);
  return {
    state,
    connection(id: string): SidecarConnection {
      const connection = connections.get(id);
      if (!connection) throw new Error("Unknown sidecar");
      return connection;
    },
    start(): void {
      for (const connection of connections.values()) void connection.connect();
    },
    stop(): void {
      for (const connection of connections.values()) connection.stop();
    },
    async add(value: string, label: string): Promise<string> {
      const baseUrl = normalizeBase(value);
      if (state.list.some((item) => item.baseUrl === baseUrl)) {
        throw new Error("Sidecar already added");
      }
      const health = await request<{ ok: boolean }>(apiBase(baseUrl), "health");
      if (!health.ok) throw new Error("This URL is not an OTK sidecar");
      const spec = {
        id: crypto.randomUUID(),
        baseUrl,
        label: label.trim() || new URL(baseUrl).host,
      };
      setState((draft) => {
        draft.list.push({
          ...spec,
          status: "connecting",
          harness: "connecting",
        });
      });
      install(spec);
      // Persist after Solid's default microtask batch commits the new list.
      queueMicrotask(persist);
      await connections.get(spec.id)!.connect();
      return spec.id;
    },
    remove(id: string): void {
      if (id === LOCAL_SIDECAR) return;
      connections.get(id)?.stop();
      connections.delete(id);
      setState((draft) => {
        draft.list = draft.list.filter((item) => item.id !== id);
      });
      queueMicrotask(persist);
    },
  };
}
