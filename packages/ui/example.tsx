// SPDX-License-Identifier: LGPL-3.0-only
import {
  createUiRegistries,
  registerGenericTool,
  ToolLine,
  UiProvider,
} from "./mod.ts";
import type { ExternalCall, Preferences } from "@otk/protocol";
import type { Element } from "solid-js";
/** Minimal composition with a chosen fallback and consumer-owned navigation. */
export function ToolExample(
  props: { call: ExternalCall; prefs: Preferences; onOpen(id: string): void },
): Element {
  const ui = createUiRegistries();
  registerGenericTool(ui.tools);
  return (
    <UiProvider registries={ui}>
      <ToolLine
        call={props.call}
        prefs={props.prefs}
        paneWidth={800}
        waiting={false}
        genericOutput
        onOpenChild={props.onOpen}
      />
    </UiProvider>
  );
}
