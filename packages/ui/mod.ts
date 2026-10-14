// SPDX-License-Identifier: LGPL-3.0-only
/** Reusable Solid 2 UI, client bindings and consumer-owned feature registries. */
export { default as Blocks } from "./components/Blocks.tsx";
export { default as Code } from "./components/Code.tsx";
export { default as Diff } from "./components/Diff.tsx";
export { default as Message } from "./components/Message.tsx";
export { default as ToolLine } from "./components/ToolLine.tsx";
export { default as ToolFrame } from "./components/tools/ToolFrame.tsx";
export { default as ToolOutput } from "./components/tools/ToolOutput.tsx";
export {
  default as GenericTool,
  registerGenericTool,
} from "./components/tools/GenericTool.tsx";
export { default as Prompt } from "./components/Prompt.tsx";
export { default as SessionView } from "./components/SessionView.tsx";
export { default as Sidebar } from "./components/Sidebar.tsx";
export { default as Settings } from "./components/Settings.tsx";
export { default as Login } from "./components/Login.tsx";
export { default as Setup } from "./components/Setup.tsx";
export {
  default as PermissionDock,
  registerPermissionDock,
} from "./components/PermissionDock.tsx";
export {
  default as QuestionDock,
  registerQuestionDock,
} from "./components/QuestionDock.tsx";
export { default as DisplayMenu } from "./components/DisplayMenu.tsx";
export { createToggles, type Toggles } from "./components/Toggles.ts";
export { default as Docks } from "./components/Docks.tsx";
export { createIndex } from "./state/index.ts";
export { createSession } from "./state/session.ts";
export { createSidecars } from "./state/sidecars.ts";
export { solidState } from "./state/binding.ts";
export * from "./registries/renderers.ts";
export * from "./registries/prompt.ts";
export * from "./registries/context.tsx";
export * from "./components/prompt/model.ts";
export type {
  CompletionOption,
  MentionSources,
} from "./components/prompt/autocomplete.ts";
export { registerBashTool } from "./components/tools/BashTool.tsx";
export { registerReadTool } from "./components/tools/ReadTool.tsx";
export { registerSearchTool } from "./components/tools/SearchTool.tsx";
export { registerFetchTool } from "./components/tools/FetchTool.tsx";
export { registerWebSearchTool } from "./components/tools/WebSearchTool.tsx";
export { registerSkillTool } from "./components/tools/SkillTool.tsx";
export { registerEditTool } from "./components/tools/EditTool.tsx";
export { registerWriteTool } from "./components/tools/WriteTool.tsx";
export { registerPatchTool } from "./components/tools/PatchTool.tsx";
export { registerTaskTool } from "./components/tools/TaskTool.tsx";
export { registerTodoTool } from "./components/Todo.tsx";
export { registerQuestionTool } from "./components/tools/QuestionTool.tsx";
export { registerTextPart } from "./components/parts/TextPart.tsx";
export { registerReasoningPart } from "./components/parts/ReasoningPart.tsx";
export { registerToolPart } from "./components/parts/ToolPart.tsx";
export { registerFilePart } from "./components/parts/FilePart.tsx";
export { registerAgentPart } from "./components/parts/AgentPart.tsx";
export { registerCompactionPart } from "./components/parts/CompactionPart.tsx";
export { registerUnknownPart } from "./components/parts/UnknownPart.tsx";
export { registerMetadataParts } from "./components/parts/MetadataPart.ts";
export { registerShellPrompt } from "./features/prompt/shell.ts";
export { registerMentionsPrompt } from "./features/prompt/mentions.ts";
export { registerSlashPrompt } from "./features/prompt/slash.ts";
export { registerHistoryPrompt } from "./features/prompt/history.ts";
export { registerPastePrompt } from "./features/prompt/paste.ts";
export { registerAttachmentsPrompt } from "./features/prompt/attachments.tsx";
export { registerEditorPrompt } from "./features/prompt/editor.tsx";
