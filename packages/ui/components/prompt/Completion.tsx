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
import { ownedCommand } from "../../keyboard/context.tsx";

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
    connected: ctx.props.connected && ctx.supports("prompt"),
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
  const close = ownedCommand(ctx, {
    id: "prompt.complete.close",
    title: "Close completion",
    category: "Prompt",
    hidden: true,
    run: clear,
  });
  const move = ownedCommand(ctx, {
    id: "prompt.complete.move",
    title: "Move completion",
    category: "Prompt",
    hidden: true,
    run: (_context, delta: number) =>
      setChoice((choice() + delta + options().length) % options().length),
  });
  const choose = ownedCommand(ctx, {
    id: "prompt.complete.choose",
    title: "Choose completion",
    category: "Prompt",
    hidden: true,
    run: (_context, args: { index: number; expand?: boolean }) =>
      select(args.index, args.expand),
  });
  ctx.own(
    ctx.keyboard.layer(
      "prompt.complete.close",
      () => visible() && ctx.focused(),
      15,
    ),
  );
  return {
    key(event) {
      if (
        !visible() ||
        !["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)
      ) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") void close().catch(ctx.fail);
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        void move(event.key === "ArrowUp" ? -1 : 1).catch(ctx.fail);
      } else {void choose({ index: choice(), expand: event.key === "Tab" })
          .catch(ctx.fail);}
      return true;
    },
    beforeInput(): Element {
      return (
        <Show when={visible()}>
          <Autocomplete
            options={options()}
            selected={choice()}
            onSelect={(index) => void choose({ index }).catch(ctx.fail)}
          />
        </Show>
      );
    },
  };
}
