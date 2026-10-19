// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type {
  InboxRpc,
  ModelCatalogOwner,
  ToolCompletionSource,
} from "@otk/client";
import type {
  CapabilityName,
  HistoryEntry,
  IndexEntry,
  PermissionRequest,
  Preferences,
  PromptPart,
  QuestionRequest,
} from "@otk/protocol";

/** Session-scoped data and typed operations, independent of any feature list. */
export interface SessionPorts {
  /** Reactive advertised features; transport loss must not unmount dirty owners. */
  supports(capability: CapabilityName): boolean;
  rpc: InboxRpc["call"];
  /** Reactive identity of the current welcomed transport connection. */
  connectionKey?(): unknown;
  onToolCompleted?: ToolCompletionSource;
  modelCatalog?: ModelCatalogOwner;
  sessionID(): string;
  directory(): Promise<string>;
  entry(id: string): IndexEntry | undefined;
  /** Consumer-supplied project/task context for a session's surfaces. */
  location?(id: string): string;
  permissions(): PermissionRequest[];
  questions(): QuestionRequest[];
  prefs(): Preferences;
  dirty(owner: string, value: boolean): void;
  act<T>(action: () => Promise<T>): Promise<T>;
  history(): Promise<HistoryEntry[]>;
  attachments(parts: PromptPart[]): Promise<PromptPart[]>;
}
const Context = createContext<SessionPorts>();
export function SessionProvider(
  props: { ports: SessionPorts; children: Element },
): Element {
  return <Context value={props.ports}>{props.children}</Context>;
}
export function useSessionPorts(): SessionPorts {
  return useContext(Context);
}
