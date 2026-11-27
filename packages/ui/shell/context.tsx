// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type {
  ApprovalModel,
  Disclosures,
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
import { ReloadProvider } from "../state/reload.tsx";
import { DisclosuresProvider } from "../components/Disclosure.tsx";
import type { ShellWork } from "../state/shell.ts";
import {
  type FilePathPorts,
  FilePathServices,
} from "../components/PathLink.tsx";
export type { ProjectSelection } from "@otk/client";
/** Live shell resources passed to features, never a component's internal state. */
export interface ShellPorts {
  theme: ThemeEngine;
  toggles: Toggles;
  usage: SessionUsageOwner;
  rename?: SessionRename;
  projectRename?: import("@otk/client").ProjectRename;
  transcript: {
    messages(): Message[];
    records?():
      | Pick<
        import("@otk/client").TranscriptOwner,
        "state" | "interaction" | "nativeSource"
      >
      | undefined;
    exhausted(): boolean;
    paging(): boolean;
    older(): Promise<void>;
    reveal(messageID: string): Promise<void>;
  };
  servers(): SidecarState[];
  forms?: import("@otk/client").ServerResources["forms"];
  filePaths?: FilePathPorts;
  connection(id: string): SidecarConnection;
  inbox(id: string): InboxModel;
  approvals(id: string): ApprovalModel;
  reportFailure?(cause: unknown): void;
  openProject(project: ProjectSelection): void;
  addToPrompt(text: string, label: string): void;
  project(): ProjectSelection | undefined;
  entries(): MergedEntry[];
  entry(server: string, session: string): IndexEntry | undefined;
  projectEntries(project: ProjectSelection): MergedEntry[];
  projectLabel: import("@otk/client").ServerResources["projectLabel"];
  projectMetadata: import("@otk/client").ServerResources["projectMetadata"];
  metadataEntry: import("@otk/client").ServerResources["metadataEntry"];
  sessionRows: import("@otk/client").ServerResources["sessionRows"];
  holdTaskOrder?: import("@otk/client").ServerResources["holdTaskOrder"];
  sessionRowsReady: import("@otk/client").ServerResources["sessionRowsReady"];
  sessionRowsLoading:
    import("@otk/client").ServerResources["sessionRowsLoading"];
  sessionRowsStatus: import("@otk/client").ServerResources["sessionRowsStatus"];
  visibleRows: import("@otk/client").ServerResources["visibleRows"];
  projectProgress: import("@otk/client").ServerResources["projectProgress"];
  listInteraction(project: ProjectSelection, task?: string): ListInteraction;
  disclosures: Disclosures;
  work: ShellWork;
  selection(): Selection | undefined;
}
const Context = createContext<ShellPorts>();
export function ShellProvider(
  props: {
    ports: ShellPorts;
    children: Element;
    reload?: import("@otk/client").Reload;
  },
): Element {
  return (
    <ReloadProvider owner={props.reload}>
      <FilePathServices value={props.ports.filePaths ?? null}>
        <Context value={props.ports}>
          <DisclosuresProvider owner={props.ports.disclosures}>
            {props.children}
          </DisclosuresProvider>
        </Context>
      </FilePathServices>
    </ReloadProvider>
  );
}
export function useShellPorts(): ShellPorts {
  return useContext(Context);
}
