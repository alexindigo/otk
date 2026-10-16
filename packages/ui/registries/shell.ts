// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import type { CapabilityName } from "@otk/protocol";
import type { SessionPorts } from "./session.tsx";

export interface DialogProps<T = unknown> {
  input: T;
  close(): void;
}
export interface DialogDefinition {
  id: string;
  component(props: DialogProps): Element;
}
export class DialogRegistry {
  #items = new Map<string, DialogDefinition>();
  register<T = unknown>(
    definition: { id: string; component(props: DialogProps<T>): Element },
  ): void {
    if (this.#items.has(definition.id)) {
      throw new Error(`Duplicate dialog: ${definition.id}`);
    }
    this.#items.set(definition.id, definition as DialogDefinition);
  }
  resolve(id: string): DialogDefinition | undefined {
    return this.#items.get(id);
  }
}
export interface PanelDefinition {
  id: string;
  title: string;
  icon: string;
  capability?: CapabilityName;
  component(): Element;
}
export interface TakeoverDefinition {
  id: string;
  capability: CapabilityName;
  component(): Element;
  active?(session: SessionPorts): boolean;
}
/** Open collections; consumers select features, machinery knows no implementations. */
export class SurfaceRegistry<
  T extends { id: string; capability?: CapabilityName },
> {
  #items = new Map<string, T>();
  register(definition: T): void {
    if (this.#items.has(definition.id)) {
      throw new Error(`Duplicate surface: ${definition.id}`);
    }
    this.#items.set(definition.id, definition);
  }
  available(supports: (capability: CapabilityName) => boolean): T[] {
    return [...this.#items.values()].filter((item) =>
      !item.capability || supports(item.capability)
    );
  }
}
