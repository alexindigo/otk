// SPDX-License-Identifier: LGPL-3.0-only
/** OTK application core: backend-neutral services and feature adapters. */
export { type CoreOptions, type CoreServer, startCore } from "./service.ts";
export {
  type RpcContext,
  type RpcDefinition,
  RpcRegistry,
} from "./ws/registry.ts";
export { Connections } from "./ws/connections.ts";
export { IndexStore } from "./index/store.ts";
export * from "./config/loader.ts";
export * from "./config/schema.ts";
export { AuthState } from "./auth/state.ts";
export {
  hashPassword,
  LocalAuth,
  timingSafeEqual,
  verifyPassword,
} from "./auth/local.ts";
export { allowedOrigin } from "./auth/middleware.ts";
export { serve } from "./http/server.ts";
export { staticResponse } from "./http/static.ts";
export { object, text } from "./ws/params.ts";
export { MAX_UPLOAD_BYTES, promptParts } from "./features/prompt-parts.ts";
export { register as registerSessions } from "./features/sessions.ts";
export { register as registerPrompt } from "./features/prompt.ts";
export { register as registerShell } from "./features/shell.ts";
export { register as registerCommands } from "./features/commands.ts";
export { register as registerHistory } from "./features/history.ts";
export { register as registerFiles } from "./features/files.ts";
export { register as registerAgents } from "./features/agents.ts";
export { register as registerModels } from "./features/models.ts";
export { register as registerUsage } from "./features/usage.ts";
export { register as registerResources } from "./features/resources.ts";
export { register as registerPermissions } from "./features/permissions.ts";
export { register as registerQuestions } from "./features/questions.ts";
export { register as registerRevert } from "./features/revert.ts";
export { prefsOptions, register as registerPrefs } from "./features/prefs.ts";
export { register as registerLayout } from "./features/layout.ts";
export {
  frecencyOptions,
  register as registerFrecency,
} from "./features/frecency.ts";
