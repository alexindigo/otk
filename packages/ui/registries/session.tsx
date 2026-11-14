// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type {
  ApprovalModel,
  DirectoryCatalogLease,
  FeedbackOwner,
  FrecencyCatalogLease,
  InboxRpc,
  ModelCatalogOwner,
  SessionSubmission,
  ToolCompletionSource,
} from "@otk/client";
import type {
  CapabilityName,
  HistoryEntry,
  IndexEntry,
  ModelRef,
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
  /** Both serving transport and native link are live; unknown is not live. */
  connected?(): boolean;
  onToolCompleted?: ToolCompletionSource;
  modelCatalog?: ModelCatalogOwner;
  directoryCatalog?: DirectoryCatalogLease;
  frecencyCatalog?: FrecencyCatalogLease;
  approvals?: ApprovalModel;
  feedback?: FeedbackOwner;
  sessionID(): string;
  failureTarget?(): import("@otk/protocol").FailureTarget;
  directory(): Promise<string>;
  entry(id: string): IndexEntry | undefined;
  /** Consumer-supplied project/task context for a session's surfaces. */
  location?(id: string): string;
  permissions(): PermissionRequest[];
  permissionVisible?(request: PermissionRequest): boolean;
  questions(): QuestionRequest[];
  forms?(): readonly import("@otk/protocol").FormRequest[];
  prefs(): Preferences;
  dirty(owner: string, value: boolean, input?: string): void;
  act<T>(action: () => Promise<T>): Promise<T>;
  /** Submission admission: promote to a task, then record a successful action. */
  submit: SessionSubmission;
  history(): Promise<HistoryEntry[]>;
  attachments(parts: PromptPart[]): Promise<PromptPart[]>;
  compact?(model: ModelRef): Promise<void>;
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
