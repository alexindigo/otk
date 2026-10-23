// SPDX-License-Identifier: LGPL-3.0-only
import type { CommandOption, PromptPart } from "@otk/protocol";
import type { Chip, Draft } from "./drafts.ts";
import { createState, type StateFactory } from "./state.ts";

export interface CompletionOption {
  id: string;
  label: string;
  description?: string;
  path?: string;
  directory?: boolean;
  part?: PromptPart;
  aliases?: string[];
  command?: CommandOption;
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
export interface CompletionInput {
  input: string;
  mode: Draft["mode"];
  caret: number;
  connected: boolean;
  chips: readonly Pick<Chip, "start" | "end">[];
}
export interface PromptCompletionState {
  readonly token: PromptCompletion | undefined;
  readonly options: CompletionOption[];
  readonly choice: number;
  readonly visible: boolean;
}
export interface PromptCompletionOwner {
  state: PromptCompletionState;
  subscribe(listener: (state: PromptCompletionState) => void): () => void;
  update(input: CompletionInput): Promise<void>;
  clear(): void;
  move(delta: number): void;
  choose(index: number, expand?: boolean): void;
  dispose(): void;
}

/** Generic per-prompt completion lifetime. Sources own their feature-specific work. */
export function createPromptCompletion(config: {
  sources: readonly PromptSource[];
  fail(error: unknown): void;
  factory?: StateFactory;
}): PromptCompletionOwner {
  const store = (config.factory ?? createState)({ revision: 0 });
  let alive = true, generation = 0, choice = 0;
  let completion: { token: PromptCompletion; source: PromptSource } | undefined;
  let options: CompletionOption[] = [];
  const state: PromptCompletionState = {
    get token() {
      void store.state.revision;
      return completion?.token;
    },
    get options() {
      void store.state.revision;
      return options;
    },
    get choice() {
      void store.state.revision;
      return choice;
    },
    get visible() {
      void store.state.revision;
      return !!completion && options.length > 0;
    },
  };
  const publish = () =>
    store.update((value) => {
      value.revision++;
    });
  const reset = () => {
    generation++;
    completion = undefined;
    options = [];
    choice = 0;
    publish();
  };
  return {
    state,
    subscribe: (listener) => store.subscribe(() => listener(state)),
    async update(input) {
      if (!alive) return;
      let found: typeof completion;
      if (
        input.connected && input.mode === "normal" &&
        !input.chips.some((chip) =>
          chip.start !== undefined && chip.end !== undefined &&
          input.caret >= chip.start && input.caret <= chip.end
        )
      ) {
        for (const source of config.sources) {
          const token = source.trigger(input.input, input.caret);
          if (token) {
            found = { source, token };
            break;
          }
        }
      }
      const revision = ++generation;
      completion = found;
      options = [];
      choice = 0;
      publish();
      if (!found || !alive || revision !== generation) return;
      try {
        const result = await found.source.options(found.token);
        if (!alive || revision !== generation) return;
        options = result;
        publish();
      } catch (error) {
        if (alive && revision === generation) config.fail(error);
      }
    },
    clear() {
      if (alive) reset();
    },
    move(delta) {
      if (!alive || !state.visible) return;
      choice = ((choice + delta) % options.length + options.length) %
        options.length;
      publish();
    },
    choose(index, expand = false) {
      const current = completion, option = options[index];
      if (!alive || !current || !option) return;
      const revision = generation;
      current.source.select(current.token, option, expand);
      if (alive && revision === generation && (!expand || !option.directory)) {
        reset();
      }
    },
    dispose() {
      if (!alive) return;
      alive = false;
      reset();
    },
  };
}
