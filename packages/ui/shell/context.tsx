// SPDX-License-Identifier: LGPL-3.0-only
import { createContext, type Element, useContext } from "solid-js";
import type {
  ApprovalModel,
  InboxModel,
  MergedEntry,
  ProjectSelection,
  Selection,
  SessionUsageOwner,
  SidecarConnection,
  SidecarState,
} from "@otk/client";
import type { Toggles } from "../components/Toggles.ts";
import type { ThemeEngine } from "../theme/engine.ts";
export type { ProjectSelection } from "@otk/client";
/** Live shell resources passed to features, never a component's internal state. */
export interface ShellPorts {
  theme: ThemeEngine;
  toggles: Toggles;
  usage: SessionUsageOwner;
  servers(): SidecarState[];
  connection(id: string): SidecarConnection;
  inbox(id: string): InboxModel;
  approvals(id: string): ApprovalModel;
  openProject(project: ProjectSelection): void;
  project(): ProjectSelection | undefined;
  entries(): MergedEntry[];
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
