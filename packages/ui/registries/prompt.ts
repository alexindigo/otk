// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
import type { CommandHub, PromptChoices, PromptSelection } from "@otk/client";
import type { Keyboard } from "../keyboard/dispatcher.ts";
import type { PromptPart } from "@otk/protocol";
import type { SessionPorts } from "./session.tsx";
import type { Draft, DraftChange } from "../components/prompt/model.ts";
import type { CompletionOption } from "../components/prompt/autocomplete.ts";

export type { PromptChoices } from "@otk/client";
/** Consumer-owned prompt data and operations. Features never import a consumer. */
export interface PromptProps {
  value: Draft;
  connected: boolean;
  busy?: boolean;
  suspended?: boolean;
  context?: {
    agent?: string;
    model?: import("@otk/protocol").ModelRef;
    variant?: string;
  };
  onChange(value: DraftChange): Draft;
  onSubmit(
    parts: PromptPart[],
    mode: Draft["mode"],
    selection: PromptChoices,
  ): Promise<void>;
  onAbort(): Promise<void>;
}
/** An input port keeps native selection/focus owned by the prompt component. */
export interface PromptContext extends SessionPorts {
  commands: CommandHub;
  keyboard: Keyboard;
  own(release: () => void): void;
  props: PromptProps;
  active(): boolean;
  change(update: DraftChange, caret?: number): Draft;
  selection(): { start: number; end: number };
  caret(): number;
  focus(): void;
  focused(): boolean;
  nextSelection(draft?: Draft): PromptSelection;
  ready(): Promise<void>;
  acceptFiles(files: File[]): Promise<void>;
  fail(error: unknown): void;
}
export interface PromptCompletion {
  start: number;
  end: number;
  query: string;
}
export interface PromptSource {
  trigger(input: string, caret: number): PromptCompletion | undefined;
  options(token: PromptCompletion): Promise<CompletionOption[]>;
  select(
    token: PromptCompletion,
    option: CompletionOption,
    expand: boolean,
  ): void;
}
/** Feature instances are per mounted prompt and retain their own async lifetime. */
export interface PromptFeature {
  ready?(): Promise<void>;
  source?: PromptSource;
  key?(event: KeyboardEvent): boolean;
  paste?(event: ClipboardEvent): void | Promise<void>;
  drop?(files: File[]): void | Promise<void>;
  beforeSubmit?(draft: Draft): boolean | Promise<boolean>;
  submit?(
    draft: Draft,
    parts: PromptPart[],
    selection: PromptChoices,
  ): boolean | Promise<boolean>;
  submitted?(
    draft: Draft,
    selection: PromptChoices,
    handled: boolean,
  ): void | Promise<void>;
  selection?(draft: Draft): PromptSelection;
  settings?(): Element;
  enabled?(): boolean | undefined;
  label?(): string;
  placeholder?(): string;
  beforeInput?(): Element;
  actions?(): Element;
  overlay?(): Element;
}
export interface PromptDefinition {
  id: string;
  create(context: PromptContext): PromptFeature;
}
export class PromptRegistry {
  #features = new Map<string, PromptDefinition>();
  register(feature: PromptDefinition): void {
    if (this.#features.has(feature.id)) {
      throw new Error(`Duplicate prompt feature: ${feature.id}`);
    }
    this.#features.set(feature.id, feature);
  }
  create(context: PromptContext): PromptFeature[] {
    return [...this.#features.values()].map((feature) =>
      feature.create(context)
    );
  }
}
