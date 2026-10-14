// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import type {
  Part,
  PermissionRequest,
  Preferences,
  ToolCall,
} from "@otk/protocol";

/** Inputs passed to every tool renderer; behavior belongs to injected callbacks. */
export interface ToolProps {
  call: ToolCall;
  genericOutput: boolean;
  directory?: string;
  waiting: boolean;
  prefs: Preferences;
  paneWidth: number;
  onOpenChild(id: string): void;
}
export type ToolRenderer = (props: ToolProps) => Element;
export type ToolRenderProps<K extends ToolCall["tool"]> =
  & Omit<ToolProps, "call">
  & {
    call: Extract<ToolCall, { tool: K }>;
  };

/** An isolated renderer collection; generic calls resolve by their external name. */
export class ToolRegistry {
  #renderers = new Map<
    string,
    { component: ToolRenderer; accepts?: (call: ToolCall) => boolean }
  >();
  #fallback?: ToolRenderer;
  register<K extends ToolCall["tool"]>(
    tool: K,
    component: (props: ToolRenderProps<K>) => Element,
    accepts: (call: ToolCall) => boolean,
  ): void;
  register(tool: string, component: ToolRenderer): void;
  register(
    tool: string,
    component: ToolRenderer | ((props: never) => Element),
    accepts?: (call: ToolCall) => boolean,
  ): void {
    if (this.#renderers.has(tool)) throw new Error(`Duplicate tool: ${tool}`);
    this.#renderers.set(tool, {
      component: component as ToolRenderer,
      accepts,
    });
  }
  fallback(component: ToolRenderer): void {
    if (this.#fallback) throw new Error("Duplicate tool fallback");
    this.#fallback = component;
  }
  resolve(call: ToolCall): ToolRenderer | undefined {
    for (
      const key of [call.tool === "generic" ? call.name : call.tool, call.tool]
    ) {
      const candidate = this.#renderers.get(key);
      if (candidate && (!candidate.accepts || candidate.accepts(call))) {
        return candidate.component;
      }
    }
    return this.#fallback;
  }
}

/** Inputs for a message part, independent of its consumer or session model. */
export interface PartProps {
  part: Part;
  prefs: Preferences;
  streaming: boolean;
  directory?: string;
  permissions: PermissionRequest[];
  paneWidth: number;
  onOpenChild(id: string): void;
  user: boolean;
}
export type PartRenderer = (props: PartProps) => Element;
export class PartRegistry {
  #renderers = new Map<string, PartRenderer>();
  #fallback?: PartRenderer;
  register(kind: string, component: PartRenderer): void {
    if (this.#renderers.has(kind)) throw new Error(`Duplicate part: ${kind}`);
    this.#renderers.set(kind, component);
  }
  fallback(component: PartRenderer): void {
    if (this.#fallback) throw new Error("Duplicate part fallback");
    this.#fallback = component;
  }
  resolve(kind: string): PartRenderer | undefined {
    return this.#renderers.get(kind) ?? this.#fallback;
  }
}

/** A dock owns its renderer; composition supplies content and callbacks by ID. */
export interface DockDefinition {
  id: string;
  capability?: string;
  render(inputs: Readonly<Record<string, Element>>): Element;
}
export class DockRegistry {
  #docks = new Map<string, DockDefinition>();
  register(dock: DockDefinition): void {
    if (this.#docks.has(dock.id)) throw new Error(`Duplicate dock: ${dock.id}`);
    this.#docks.set(dock.id, dock);
  }
  available(capabilities: readonly string[]): DockDefinition[] {
    return [...this.#docks.values()].filter((dock) =>
      !dock.capability || capabilities.includes(dock.capability)
    );
  }
}
