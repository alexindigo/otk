// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect } from "solid-js";
import {
  type ComposerConnection,
  type ComposerSelection,
  createComposerSelection,
} from "@otk/client";
import type { PromptContext } from "../../registries/prompt.ts";
import { solidState } from "../../state/binding.ts";

/** Thin reactive binding; the client owns resources, readiness and all intents. */
export function bindComposerSelection(ctx: PromptContext): ComposerSelection {
  const connection = (): ComposerConnection => ({
    key: ctx.connectionKey?.() ?? ctx.rpc,
    connected: ctx.props.connected,
    agents: ctx.supports("agents"),
    models: ctx.supports("models"),
  });
  const owner = createComposerSelection({
    draft: () => ctx.props.value,
    change: ctx.change,
    context: () => ctx.props.context,
    connection,
    onToolCompleted: ctx.onToolCompleted,
    modelCatalog: ctx.modelCatalog,
    load: {
      agents: (signal) =>
        ctx.rpc(
          "agents.list",
          { sessionID: ctx.sessionID(), primary: true },
          signal,
        ),
      models: (signal) =>
        ctx.rpc("models.list", { sessionID: ctx.sessionID() }, signal),
    },
    prefs: {
      get: ctx.prefs,
      set: (key, value) => ctx.commands.run("prefs.set", { key, value }),
    },
    factory: solidState,
  });
  createEffect(connection, owner.connect);
  ctx.own(owner.dispose);
  return owner;
}
