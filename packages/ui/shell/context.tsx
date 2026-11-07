// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type {
  ApprovalModel,
  InboxModel,
  ListInteraction,
  MergedEntry,
  ProjectSelection,
  Selection,
  SessionRename,
  SessionUsageOwner,
  SidecarConnection,
  SidecarState,
} from "@otk/client";
import type { Toggles } from "../components/Toggles.ts";
import type { IndexEntry, Message } from "@otk/protocol";
import type { ThemeEngine } from "../theme/engine.ts";
export type { ProjectSelection } from "@otk/client";
/** Live shell resources passed to features, never a component's internal state. */
export interface ShellPorts {
  theme: ThemeEngine;
  toggles: Toggles;
  usage: SessionUsageOwner;
  rename?: SessionRename;
  transcript: {
    messages(): Message[];
    exhausted(): boolean;
    paging(): boolean;
    older(): Promise<void>;
  };
  servers(): SidecarState[];
  connection(id: string): SidecarConnection;
  inbox(id: string): InboxModel;
  approvals(id: string): ApprovalModel;
  openProject(project: ProjectSelection): void;
  project(): ProjectSelection | undefined;
  entries(): MergedEntry[];
  entry(server: string, session: string): IndexEntry | undefined;
  projectEntries(project: ProjectSelection): MergedEntry[];
  projectMetadata: import("@otk/client").ServerResources["projectMetadata"];
  metadataEntry: import("@otk/client").ServerResources["metadataEntry"];
  sessionRows: import("@otk/client").ServerResources["sessionRows"];
  sessionRowsReady: import("@otk/client").ServerResources["sessionRowsReady"];
  sessionRowsLoading:
    import("@otk/client").ServerResources["sessionRowsLoading"];
  sessionRowsStatus: import("@otk/client").ServerResources["sessionRowsStatus"];
  visibleRows: import("@otk/client").ServerResources["visibleRows"];
  projectProgress: import("@otk/client").ServerResources["projectProgress"];
  listInteraction(project: ProjectSelection, task?: string): ListInteraction;
  selection(): Selection | undefined;
}
const Context = createContext<ShellPorts>();
export function ShellProvider(
  props: { ports: ShellPorts; children: Element },
): Element {
  return <Context value={props.ports}>{props.children}</Context>;
}
export function useShellPorts(): ShellPorts {
  return useContext(Context);
}
