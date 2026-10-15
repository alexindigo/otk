// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import type {
  CapabilityName,
  ExternalCall,
  ExternalPart,
  Part,
  PartKinds,
  PermissionRequest,
  Preferences,
  ToolCall,
  ToolKinds,
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
export type ToolRenderProps<K extends keyof ToolKinds> =
  & Omit<ToolProps, "call">
  & {
    call: ToolKinds[K];
  };

/** Typed OTK kinds and external names have independent registration namespaces. */
export class ToolRegistry {
  #typed = new Map<string, ToolRenderer>();
  #external = new Map<string, ToolRenderer>();
  #fallback?: ToolRenderer;
  registerTyped<K extends keyof ToolKinds>(
    tool: K,
    component: (props: ToolRenderProps<K>) => Element,
  ): void {
    if (this.#typed.has(tool)) throw new Error(`Duplicate tool: ${tool}`);
    this.#typed.set(tool, component as ToolRenderer);
  }
  register(
    name: string,
    component: (
      props: Omit<ToolProps, "call"> & { call: ExternalCall },
    ) => Element,
  ): void {
    if (this.#external.has(name)) throw new Error(`Duplicate tool: ${name}`);
    this.#external.set(name, component as ToolRenderer);
  }
  fallback(component: ToolRenderer): void {
    if (this.#fallback) throw new Error("Duplicate tool fallback");
    this.#fallback = component;
  }
  resolve(call: ToolCall): ToolRenderer | undefined {
    return (call.tool === "external"
      ? this.#external.get(call.name)
      : this.#typed.get(call.tool)) ?? this.#fallback;
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
  #typed = new Map<string, PartRenderer>();
  #external = new Map<string, PartRenderer>();
  #fallback?: PartRenderer;
  registerTyped<K extends keyof PartKinds>(
    kind: K,
    component: (
      props: Omit<PartProps, "part"> & { part: PartKinds[K] },
    ) => Element,
  ): void {
    if (this.#typed.has(kind)) throw new Error(`Duplicate part: ${kind}`);
    this.#typed.set(kind, component as PartRenderer);
  }
  register(
    name: string,
    component: (
      props: Omit<PartProps, "part"> & { part: ExternalPart },
    ) => Element,
  ): void {
    if (this.#external.has(name)) throw new Error(`Duplicate part: ${name}`);
    this.#external.set(name, component as PartRenderer);
  }
  fallback(component: PartRenderer): void {
    if (this.#fallback) throw new Error("Duplicate part fallback");
    this.#fallback = component;
  }
  resolve(part: Part): PartRenderer | undefined {
    return (part.kind === "external"
      ? this.#external.get(part.name)
      : this.#typed.get(part.kind)) ?? this.#fallback;
  }
}

/** A dock owns its renderer; composition supplies content and callbacks by ID. */
export interface DockDefinition {
  id: string;
  capability?: CapabilityName;
  render(inputs: Readonly<Record<string, Element>>): Element;
}
export class DockRegistry {
  #docks = new Map<string, DockDefinition>();
  register(dock: DockDefinition): void {
    if (this.#docks.has(dock.id)) throw new Error(`Duplicate dock: ${dock.id}`);
    this.#docks.set(dock.id, dock);
  }
  available(capabilities: readonly CapabilityName[]): DockDefinition[] {
    return [...this.#docks.values()].filter((dock) =>
      !dock.capability || capabilities.includes(dock.capability)
    );
  }
}
