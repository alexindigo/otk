// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, createSignal, type Element, Show } from "solid-js";
import type {
  PromptCompletion,
  PromptContext,
  PromptFeature,
  PromptSource,
} from "../../registries/prompt.ts";
import type { CompletionOption } from "./autocomplete.ts";
import Autocomplete from "./Autocomplete.tsx";

/** Coordinate injected sources without knowing any concrete trigger or feature. */
export function createCompletion(
  ctx: PromptContext,
  features: PromptFeature[],
): PromptFeature {
  const [completion, setCompletion] = createSignal<
      { token: PromptCompletion; source: PromptSource }
    >(),
    [options, setOptions] = createSignal<CompletionOption[]>([]),
    [choice, setChoice] = createSignal(0);
  let generation = 0;
  const clear = () => {
    generation++;
    setCompletion(undefined);
    setOptions([]);
  };
  const visible = () => !!completion() && options().length > 0;
  createEffect(() => ({
    value: ctx.props.value.input,
    mode: ctx.props.value.mode,
    caret: ctx.caret(),
    connected: ctx.props.connected && ctx.props.promptEnabled !== false,
  }), ({ value, mode, caret, connected }) => {
    let found: { token: PromptCompletion; source: PromptSource } | undefined;
    if (
      connected && mode === "normal" &&
      !ctx.props.value.chips.some((chip) =>
        caret >= chip.start && caret <= chip.end
      )
    ) {
      for (const feature of features) {
        const source = feature.source, token = source?.trigger(value, caret);
        if (source && token) {
          found = { source, token };
          break;
        }
      }
    }
    const revision = ++generation;
    setCompletion(found);
    setOptions([]);
    setChoice(0);
    if (found) {
      void found.source.options(found.token).then((value) => {
        if (ctx.active() && revision === generation) setOptions(value);
      }).catch((error) => {
        if (ctx.active() && revision === generation) ctx.fail(error);
      });
    }
  });
  const select = (index: number, expand = false) => {
    const current = completion(), option = options()[index];
    if (!current || !option) return;
    current.source.select(current.token, option, expand);
    if (!expand || !option.directory) clear();
  };
  return {
    key(event) {
      if (
        !visible() ||
        !["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)
      ) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") clear();
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        setChoice(
          (choice() + (event.key === "ArrowUp" ? -1 : 1) + options().length) %
            options().length,
        );
      } else select(choice(), event.key === "Tab");
      return true;
    },
    beforeInput(): Element {
      return (
        <Show when={visible()}>
          <Autocomplete
            options={options()}
            selected={choice()}
            onSelect={(index) => select(index)}
          />
        </Show>
      );
    },
  };
}
