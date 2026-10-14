// SPDX-License-Identifier: LGPL-3.0-only
import {
  createUiRegistries,
  registerAgentPart,
  registerAttachmentsPrompt,
  registerBashTool,
  registerCompactionPart,
  registerEditorPrompt,
  registerEditTool,
  registerFetchTool,
  registerFilePart,
  registerGenericTool,
  registerHistoryPrompt,
  registerMentionsPrompt,
  registerMetadataParts,
  registerPastePrompt,
  registerPatchTool,
  registerPermissionDock,
  registerQuestionDock,
  registerQuestionTool,
  registerReadTool,
  registerReasoningPart,
  registerSearchTool,
  registerShellPrompt,
  registerSkillTool,
  registerSlashPrompt,
  registerTaskTool,
  registerTextPart,
  registerTodoTool,
  registerToolPart,
  registerUnknownPart,
  registerWebSearchTool,
  registerWriteTool,
  type UiRegistries,
} from "@otk/ui";

/** The application selects modules; each module owns its registration. */
export function applicationUi(): UiRegistries {
  const ui = createUiRegistries();
  registerGenericTool(ui.tools);
  registerBashTool(ui.tools);
  registerReadTool(ui.tools);
  registerSearchTool(ui.tools);
  registerFetchTool(ui.tools);
  registerWebSearchTool(ui.tools);
  registerSkillTool(ui.tools);
  registerEditTool(ui.tools);
  registerWriteTool(ui.tools);
  registerPatchTool(ui.tools);
  registerTaskTool(ui.tools);
  registerTodoTool(ui.tools);
  registerQuestionTool(ui.tools);
  registerTextPart(ui.parts);
  registerReasoningPart(ui.parts);
  registerToolPart(ui.parts);
  registerFilePart(ui.parts);
  registerAgentPart(ui.parts);
  registerCompactionPart(ui.parts);
  registerUnknownPart(ui.parts);
  registerMetadataParts(ui.parts);
  registerShellPrompt(ui.prompt);
  registerMentionsPrompt(ui.prompt);
  registerSlashPrompt(ui.prompt);
  registerHistoryPrompt(ui.prompt);
  registerPastePrompt(ui.prompt);
  registerAttachmentsPrompt(ui.prompt);
  registerEditorPrompt(ui.prompt);
  registerPermissionDock(ui.docks);
  registerQuestionDock(ui.docks);
  return ui;
}
