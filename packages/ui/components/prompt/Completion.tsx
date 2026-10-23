// SPDX-License-Identifier: LGPL-3.0-only
import { createEffect, type Element, Show } from "solid-js";
import { createPromptCompletion } from "@otk/client";
import type { PromptContext, PromptFeature } from "../../registries/prompt.ts";
import Autocomplete from "./Autocomplete.tsx";
import { ownedCommand } from "../../keyboard/context.tsx";
import { solidState } from "../../state/binding.ts";

/** Coordinate injected sources without knowing any concrete trigger or feature. */
export function createCompletion(
  ctx: PromptContext,
  features: PromptFeature[],
): PromptFeature {
  const owner = createPromptCompletion({
    sources: features.flatMap((feature) =>
      feature.source ? [feature.source] : []
    ),
    factory: solidState,
    fail: ctx.fail,
  });
  ctx.own(() => owner.dispose());
  createEffect(() => ({
    input: ctx.props.value.input,
    mode: ctx.props.value.mode,
    caret: ctx.caret(),
    connected: ctx.props.connected && ctx.supports("prompt"),
    chips: ctx.props.value.chips.map((chip) => ({
      start: chip.start,
      end: chip.end,
    })),
  }), (input) => {
    void owner.update(input).catch(ctx.fail);
  });
  const close = ownedCommand(ctx, {
    id: "prompt.complete.close",
    title: "Close completion",
    category: "Prompt",
    hidden: true,
    run: () => owner.clear(),
  });
  const move = ownedCommand(ctx, {
    id: "prompt.complete.move",
    title: "Move completion",
    category: "Prompt",
    hidden: true,
    run: (_context, delta: number) => owner.move(delta),
  });
  const choose = ownedCommand(ctx, {
    id: "prompt.complete.choose",
    title: "Choose completion",
    category: "Prompt",
    hidden: true,
    run: (_context, args: { index: number; expand?: boolean }) =>
      owner.choose(args.index, args.expand),
  });
  ctx.own(
    ctx.keyboard.layer(
      "prompt.complete.close",
      () => owner.state.visible && ctx.focused(),
      15,
    ),
  );
  return {
    key(event) {
      if (
        !owner.state.visible ||
        !["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)
      ) return false;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") void close().catch(ctx.fail);
      else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        void move(event.key === "ArrowUp" ? -1 : 1).catch(ctx.fail);
      } else {void choose({
          index: owner.state.choice,
          expand: event.key === "Tab",
        })
          .catch(ctx.fail);}
      return true;
    },
    beforeInput(): Element {
      return (
        <Show when={owner.state.visible}>
          <Autocomplete
            options={owner.state.options}
            selected={owner.state.choice}
            onSelect={(index) => void choose({ index }).catch(ctx.fail)}
          />
        </Show>
      );
    },
  };
}
