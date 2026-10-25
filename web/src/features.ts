// SPDX-License-Identifier: LGPL-3.0-only
import {
  browserThemeEnvironment,
  createUiRegistries,
  registerActivityPanel,
  registerAgentPart,
  registerAttachmentsPrompt,
  registerAutoApprovePrompt,
  registerBashTool,
  registerCommandDialogs,
  registerCompactionPart,
  registerCompactPrompt,
  registerComposerPickers,
  registerEditorDialog,
  registerEditorPrompt,
  registerEditTool,
  registerFetchTool,
  registerFilePart,
  registerGenericTool,
  registerHistoryPrompt,
  registerImageDialog,
  registerMentionsPrompt,
  registerMetadataParts,
  registerOtkThemes,
  registerPastePrompt,
  registerPatchTool,
  registerPermissionTakeover,
  registerProjectDialogs,
  registerQuestionTakeover,
  registerQuestionTool,
  registerReadTool,
  registerReasoningPart,
  registerSearchTool,
  registerSessionsPanel,
  registerShellPrompt,
  registerSkillTool,
  registerSlashPrompt,
  registerTaskDialogs,
  registerTaskTool,
  registerTextPart,
  registerTodoTool,
  registerToolPart,
  registerUnknownPart,
  registerWebSearchTool,
  registerWriteTool,
  ThemeEngine,
  ThemeRegistry,
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
  registerImageDialog(ui.dialogs);
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
  registerEditorDialog(ui.dialogs);
  registerAutoApprovePrompt(ui.prompt);
  registerComposerPickers(ui.prompt);
  registerCompactPrompt(ui.prompt);
  registerPermissionTakeover(ui.takeovers);
  registerQuestionTakeover(ui.takeovers);
  registerCommandDialogs(ui.dialogs);
  registerProjectDialogs(ui.dialogs);
  registerTaskDialogs(ui.dialogs);
  registerSessionsPanel(ui.panels);
  registerActivityPanel(ui.panels);
  return ui;
}

/** Themes, like renderers, are explicitly selected at application composition. */
export function applicationTheme(committed: string): ThemeEngine {
  const themes = new ThemeRegistry();
  registerOtkThemes(themes);
  return new ThemeEngine(themes, browserThemeEnvironment(), committed);
}
