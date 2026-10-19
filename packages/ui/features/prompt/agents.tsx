// SPDX-License-Identifier: LGPL-3.0-only
import "./pickers.css" with { type: "text" };
import { onSettled, Show } from "solid-js";
import type { ComposerCatalog, SelectionField } from "@otk/client";
import type { ModelRef } from "@otk/protocol";
import type { PromptRegistry } from "../../registries/prompt.ts";
import { ownedCommand } from "../../keyboard/context.tsx";
import ListPicker, {
  type ListPickerControl,
} from "../../components/ListPicker.tsx";
import { ChevronDownIcon, StarIcon } from "../../components/ChromeIcons.tsx";
import { bindComposerSelection } from "./catalog.ts";
import { selection as selectionState } from "../../components/selection.ts";
import { ModelLabel, selectionLabel } from "../../components/prompt/labels.tsx";

/** One presentation rule for every projected field, including plain labels. */
function applied(field: SelectionField<unknown>): string | undefined {
  if (field.userChosen || field.value === undefined) return undefined;
  return field.source === "configured" ? "agent default" : "catalog default";
}

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
                <span
                  {...selectionState({
                    kind: "candidate",
                    selected: false,
                    applied: !!applied(selection().agent),
                  })}
                >
                  {selectionLabel(selection().agent.value ?? "Default agent")}
                </span>
              }
            >
              <ListPicker
                label="Choose agent"
                triggerLabel={`Agent: ${
                  selectionLabel(selection().agent.value ?? "Default agent")
                }`}
                class="otk-agent-picker"
                applied={applied(selection().agent)}
                triggerColor={selection().agent.color}
                trigger={
                  <>
                    <span class="otk-composer-agent">
                      {selectionLabel(
                        selection().agent.value ?? "Default agent",
                      )}
                    </span>
                    <ChevronDownIcon />
                  </>
                }
                groups={[{
                  key: "agents",
                  items: (owner.state.agents.value ?? []).map((agent) => ({
                    key: agent.name,
                    value: agent.name,
                    label: selectionLabel(agent.name),
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
                <span
                  {...selectionState({
                    kind: "candidate",
                    selected: false,
                    applied: !!applied(selection().model),
                  })}
                >
                  <ModelLabel
                    provider={selection().model.providerName}
                    name={selection().model.name}
                  />
                </span>
              }
            >
              <ListPicker<ModelRef>
                label="Choose model"
                triggerLabel={`Model: ${
                  selection().model.providerName
                    ? `${selection().model.providerName} `
                    : ""
                }${selection().model.name ?? "Default model"}`}
                class="otk-model-picker"
                applied={applied(selection().model)}
                trigger={
                  <>
                    <ModelLabel
                      provider={selection().model.providerName}
                      name={selection().model.name}
                    />
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
                    selectionLabel(selection().variant.value ?? "Default")
                  }`}
                  class="otk-variant-picker"
                  applied={applied(selection().variant)}
                  trigger={
                    <>
                      <span>
                        {selectionLabel(selection().variant.value ?? "Default")}
                      </span>
                      <ChevronDownIcon />
                    </>
                  }
                  groups={[{
                    key: "variants",
                    items: [
                      {
                        key: "",
                        value: undefined,
                        label: "Default",
                        description: applied(selection().variant)
                          ? selectionLabel(
                            selection().variant.value ?? "Default",
                          )
                          : undefined,
                      },
                      ...selection().model.variants.map((variant) => ({
                        key: variant,
                        value: variant,
                        label: selectionLabel(variant),
                      })),
                    ],
                  }]}
                  selected={selection().variantChoice ?? ""}
                  onPick={owner.chooseVariant}
                  focusAfterPick={ctx.focus}
                />
              </Show>
              <Show
                when={!owner.catalogKnown() &&
                  selection().variant.value !== undefined}
              >
                <span
                  {...selectionState({
                    kind: "candidate",
                    selected: false,
                    applied: !!applied(selection().variant),
                  })}
                >
                  {selectionLabel(selection().variant.value!)}
                </span>
              </Show>
            </Show>
          </>
        ),
      };
    },
  });
}
