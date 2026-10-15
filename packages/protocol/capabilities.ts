// SPDX-License-Identifier: LGPL-3.0-only
import {
  legacyPromptCapabilities,
  type PromptCapabilities,
} from "./capabilities/prompt.ts";
import {
  legacyShellCapabilities,
  type ShellCapabilities,
} from "./capabilities/shell.ts";
import {
  type CommandsCapabilities,
  legacyCommandsCapabilities,
} from "./capabilities/commands.ts";
import {
  type HistoryCapabilities,
  legacyHistoryCapabilities,
} from "./capabilities/history.ts";
import {
  type FilesCapabilities,
  legacyFilesCapabilities,
} from "./capabilities/files.ts";
import {
  type AgentsCapabilities,
  legacyAgentsCapabilities,
} from "./capabilities/agents.ts";
import {
  legacyResourcesCapabilities,
  type ResourcesCapabilities,
} from "./capabilities/resources.ts";
import {
  legacyPermissionsCapabilities,
  type PermissionsCapabilities,
} from "./capabilities/permissions.ts";
import {
  legacyQuestionsCapabilities,
  type QuestionsCapabilities,
} from "./capabilities/questions.ts";
import {
  legacyRevertCapabilities,
  type RevertCapabilities,
} from "./capabilities/revert.ts";

/** Open feature-owned operation contracts; extensions augment this interface. */
export interface CapabilityContracts
  extends
    PromptCapabilities,
    ShellCapabilities,
    CommandsCapabilities,
    HistoryCapabilities,
    FilesCapabilities,
    AgentsCapabilities,
    ResourcesCapabilities,
    PermissionsCapabilities,
    QuestionsCapabilities,
    RevertCapabilities {}
export type CapabilityName = Extract<keyof CapabilityContracts, string>;
export type Capabilities = Partial<CapabilityContracts>;

/** Advertise actual implementations, never a separately maintained name list. */
export function capabilityNames(
  capabilities: Readonly<Capabilities>,
): CapabilityName[] {
  return Object.entries(capabilities)
    .filter(([, capability]) => capability != null)
    .map(([name]) => name as CapabilityName);
}

// Historical compatibility only: extensions are not implicitly available on
// servers predating advertisements. Each original owner supplies its old name.
export const legacyCapabilities: readonly CapabilityName[] = Object.freeze([
  ...legacyPromptCapabilities,
  ...legacyShellCapabilities,
  ...legacyCommandsCapabilities,
  ...legacyHistoryCapabilities,
  ...legacyFilesCapabilities,
  ...legacyAgentsCapabilities,
  ...legacyResourcesCapabilities,
  ...legacyPermissionsCapabilities,
  ...legacyQuestionsCapabilities,
  ...legacyRevertCapabilities,
]);

export type { PromptCapability } from "./capabilities/prompt.ts";
export type { ShellCapability } from "./capabilities/shell.ts";
export type { CommandsCapability } from "./capabilities/commands.ts";
export type {
  HistoryAttachmentRef,
  HistoryCapability,
} from "./capabilities/history.ts";
export type { FilesCapability } from "./capabilities/files.ts";
export type { AgentsCapability } from "./capabilities/agents.ts";
export type { ResourcesCapability } from "./capabilities/resources.ts";
export type { PermissionsCapability } from "./capabilities/permissions.ts";
export type { QuestionsCapability } from "./capabilities/questions.ts";
export type { RevertCapability } from "./capabilities/revert.ts";
