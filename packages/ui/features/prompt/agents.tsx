// SPDX-License-Identifier: LGPL-3.0-only
import "./pickers.css" with { type: "text" };
import { onSettled, Show } from "solid-js";
import type { ComposerCatalog } from "@otk/client";
import type { ModelRef } from "@otk/protocol";
import type { PromptRegistry } from "../../registries/prompt.ts";
import { ownedCommand } from "../../keyboard/context.tsx";
import ListPicker, {
  type ListPickerControl,
} from "../../components/ListPicker.tsx";
import { ChevronDownIcon, StarIcon } from "../../components/ChromeIcons.tsx";
import { bindComposerSelection } from "./catalog.ts";

/** Render the client owner and bind its intents to the command/key/session ports. */
export function registerComposerPickers(prompt: PromptRegistry): void {
  prompt.register({
    id: "composer-pickers",
    create(ctx) {
      const owner = bindComposerSelection(ctx), selection = owner.selection;
      let agentPicker!: ListPickerControl, modelPicker!: ListPickerControl;
      const enabled = () => !ctx.props.suspended && ctx.props.connected;
      for (
        const [id, title, delta] of [["agent.cycle", "Next agent", 1], [
          "agent.cycle.reverse",
          "Previous agent",
          -1,
        ]] as const
      ) {
        ownedCommand(ctx, {
          id,
          title,
          category: "Prompt",
          enabled: () => enabled() && owner.state.agents.available,
          run: () => owner.cycleAgent(delta),
        });
      }
      ownedCommand(ctx, {
        id: "agent.choose",
        title: "Choose agent",
        category: "Prompt",
        enabled: () => enabled() && owner.state.agents.available,
        run: () => agentPicker.open(),
      });
      ownedCommand(ctx, {
        id: "model.choose",
        title: "Choose model",
        category: "Prompt",
        enabled: () => enabled() && owner.state.models.available,
        run: () => modelPicker.open(),
      });
      ownedCommand(ctx, {
        id: "variant.cycle",
        title: "Next variant",
        category: "Prompt",
        enabled: () =>
          enabled() && selection().applies.variant &&
          selection().model.variants.length > 0,
        run: owner.cycleVariant,
      });
      onSettled(() => {
        const releases = [
          ctx.keyboard.keymap.bind({
            id: "agent.cycle",
            command: "agent.cycle",
            key: "Tab",
            inPrompt: true,
            ctx: "prompt",
          }, ctx.focused),
          ctx.keyboard.keymap.bind({
            id: "agent.cycle.reverse",
            command: "agent.cycle.reverse",
            key: "Shift+Tab",
            inPrompt: true,
            ctx: "prompt",
          }, ctx.focused),
          ctx.keyboard.keymap.bind({
            id: "model.choose",
            command: "model.choose",
            key: "Mod+'",
            inPrompt: true,
            ctx: "prompt",
          }, enabled),
          ctx.keyboard.keymap.bind({
            id: "variant.cycle",
            command: "variant.cycle",
            key: "Alt+T",
            inPrompt: true,
            ctx: "prompt",
          }, enabled),
        ];
        return () => {
          for (const release of releases) release();
        };
      });
      const status = (
        catalog: ComposerCatalog<unknown>,
        retry: () => Promise<void>,
      ) => (
        <>
          <Show when={catalog.loading}>
            <p class="otk-picker-status" role="status">Loading…</p>
          </Show>
          <Show when={catalog.error}>
            <div class="otk-picker-status" role="alert">
              <span>{catalog.error}</span>
              <button type="button" onClick={() => void retry()}>Retry</button>
            </div>
          </Show>
        </>
      );
      return {
        selection,
        ready: owner.ready,
        submitted: (draft, sent, handled) =>
          owner.recordSent(sent, draft.mode, handled).catch(ctx.fail),
        settings: () => (
          <>
            <Show
              when={owner.state.agents.available}
              fallback={
                <span>{selection().agent.value ?? "Default agent"}</span>
              }
            >
              <ListPicker
                label="Choose agent"
                triggerLabel={`Agent: ${
                  selection().agent.value ?? "Default agent"
                }`}
                class="otk-agent-picker"
                trigger={
                  <>
                    <span
                      class="otk-composer-agent"
                      style={{ color: selection().agent.color }}
                    >
                      {selection().agent.value ?? "Default agent"}
                    </span>
                    <ChevronDownIcon />
                  </>
                }
                groups={[{
                  key: "agents",
                  items: (owner.state.agents.value ?? []).map((agent) => ({
                    key: agent.name,
                    value: agent.name,
                    label: agent.name,
                    description: agent.description,
                    color: agent.color,
                  })),
                }]}
                selected={selection().agent.value}
                status={status(owner.state.agents, owner.refreshAgents)}
                loading={owner.state.agents.loading}
                error={owner.state.agents.error}
                control={(control) => {
                  agentPicker = control;
                }}
                onOpen={() => void owner.refreshAgents()}
                onPick={owner.chooseAgent}
                focusAfterPick={ctx.focus}
              />
            </Show>
            <Show
              when={owner.state.models.available}
              fallback={
                <span>{selection().model.name ?? "Default model"}</span>
              }
            >
              <ListPicker<ModelRef>
                label="Choose model"
                triggerLabel={`Model: ${
                  selection().model.name ?? "Default model"
                }`}
                class="otk-model-picker"
                trigger={
                  <>
                    <span>{selection().model.name ?? "Default model"}</span>
                    <ChevronDownIcon />
                  </>
                }
                groups={owner.groups().map((group) => ({
                  ...group,
                  items: group.items.map((item) => ({
                    key: item.key,
                    value: item.ref,
                    label: item.name,
                    description: item.subtitle,
                    search:
                      `${item.providerName} ${item.ref.provider} ${item.ref.model}`,
                    tag: item.free ? "Free" : undefined,
                    action: {
                      label: `${
                        item.favourite ? "Remove" : "Add"
                      } ${item.name} ${
                        item.favourite ? "from" : "to"
                      } favourites`,
                      content: <StarIcon filled={item.favourite} />,
                      run: () => {
                        void owner.toggleFavourite(item.ref).catch(ctx.fail);
                      },
                    },
                  })),
                }))}
                selected={owner.selectedModelKey()}
                search="Search models…"
                status={status(owner.state.models, owner.refreshModels)}
                loading={owner.state.models.loading}
                error={owner.state.models.error}
                header={
                  <Show when={selection().model.unavailable}>
                    <p class="otk-picker-status">
                      {selection().model.providerName}/{selection().model.name}
                      {" "}
                      — unavailable
                    </p>
                  </Show>
                }
                control={(control) => {
                  modelPicker = control;
                }}
                onOpen={() => void owner.refreshModels()}
                onPick={owner.chooseModel}
                focusAfterPick={ctx.focus}
              />
            </Show>
            <Show when={selection().applies.variant}>
              <Show
                when={owner.catalogKnown() &&
                  selection().model.variants.length > 0}
              >
                <ListPicker<string | undefined>
                  label="Choose variant"
                  triggerLabel={`Variant: ${
                    selection().variant.value ?? "Default"
                  }`}
                  class="otk-variant-picker"
                  trigger={
                    <>
                      <span>{selection().variant.value ?? "Default"}</span>
                      <ChevronDownIcon />
                    </>
                  }
                  groups={[{
                    key: "variants",
                    items: [
                      { key: "", value: undefined, label: "Default" },
                      ...selection().model.variants.map((variant) => ({
                        key: variant,
                        value: variant,
                        label: variant,
                      })),
                    ],
                  }]}
                  selected={selection().variant.value ?? ""}
                  onPick={owner.chooseVariant}
                  focusAfterPick={ctx.focus}
                />
              </Show>
              <Show
                when={!owner.catalogKnown() &&
                  selection().variant.value !== undefined}
              >
                <span>{selection().variant.value}</span>
              </Show>
            </Show>
          </>
        ),
      };
    },
  });
}
