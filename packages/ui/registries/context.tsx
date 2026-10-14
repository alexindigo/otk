// SPDX-License-Identifier: LGPL-3.0-only
import "../theme.css" with { type: "text" };
import { createContext, type Element, useContext } from "solid-js";
import { DockRegistry, PartRegistry, ToolRegistry } from "./renderers.ts";
import { PromptRegistry } from "./prompt.ts";

/** Each consumer chooses and owns its registrations. There are no default imports. */
export interface UiRegistries {
  tools: ToolRegistry;
  parts: PartRegistry;
  prompt: PromptRegistry;
  docks: DockRegistry;
}
export function createUiRegistries(): UiRegistries {
  return {
    tools: new ToolRegistry(),
    parts: new PartRegistry(),
    prompt: new PromptRegistry(),
    docks: new DockRegistry(),
  };
}
const Context = createContext<UiRegistries>();
export function UiProvider(
  props: { registries: UiRegistries; children: Element },
): Element {
  return (
    <Context value={props.registries}>
      {props.children}
    </Context>
  );
}
export function useUiRegistries(): UiRegistries {
  return useContext(Context);
}
