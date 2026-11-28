// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type {
  ApprovalModel,
  DirectoryCatalogLease,
  EntityFacts,
  EntityIdentity,
  EntityStateStore,
  FeedbackOwner,
  FrecencyCatalogLease,
  InboxRpc,
  LiveWorkOwner,
  ModelCatalogOwner,
  QuestionResponse,
  SessionDelivery,
  SessionSubmission,
  ToolCompletionSource,
  TrailModel,
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
  RunningShells,
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
  /** The explicit approval policy controls this whole session family. */
  approvalTarget?(): { sidecarId: string; sessionID: string; title?: string };
  feedback?: FeedbackOwner;
  sessionID(): string;
  /** Name of the captured send destination, supplied by the selection owner. */
  composerTarget?(): { task?: string; session: string };
  failureTarget?(): import("@otk/protocol").FailureTarget;
  directory(): Promise<string>;
  entry(id: string): IndexEntry | undefined;
  entityFacts?(identity: EntityIdentity): EntityFacts;
  entities?(): EntityStateStore;
  status?(id: string): import("@otk/client").InboxStatus | undefined;
  /** Consumer-supplied project/task context for a session's surfaces. */
  location?(id: string): string;
  shells?(): RunningShells | undefined;
  trail?(): TrailModel | undefined;
  liveWork?: LiveWorkOwner;
  delivery?: SessionDelivery;
  stopHelper?(id: string): Promise<void>;
  clearFinished?(task: string): Promise<void>;
  permissions(): PermissionRequest[];
  permissionVisible?(request: PermissionRequest): boolean;
  questions(): QuestionRequest[];
  questionResponse?(id: string): QuestionResponse | undefined;
  observeQuestionResponse?(listener: () => void): () => void;
  forms?(): readonly import("@otk/protocol").FormRequest[];
  requests?: import("@otk/client").RequestLifetimes;
  prefs(): Preferences;
  dirty(owner: string, value: boolean, input?: string): void;
  act<T>(action: () => Promise<T>): Promise<T>;
  /** Session-bound admission; tab persistence and visit do not gate dispatch. */
  submit: SessionSubmission;
  history(): Promise<HistoryEntry[]>;
  attachments(parts: PromptPart[]): Promise<PromptPart[]>;
  compact?(model: ModelRef): Promise<void>;
}
const Context = createContext<SessionPorts | null>(null);
export function SessionProvider(
  props: { ports: SessionPorts; children: Element },
): Element {
  return <Context value={props.ports}>{props.children}</Context>;
}
export function useSessionPorts(): SessionPorts {
  const ports = useContext(Context);
  if (!ports) throw new Error("Session provider required");
  return ports;
}
/** Reusable renderers can present explicit facts outside a session surface. */
export function useOptionalSessionPorts(): SessionPorts | undefined {
  return useContext(Context) ?? undefined;
}
