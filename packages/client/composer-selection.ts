// SPDX-License-Identifier: LGPL-3.0-only
import type {
  AgentOption,
  ModelCatalog,
  ModelRef,
  Preferences,
} from "@otk/protocol";
import type { Draft, DraftChange } from "./drafts.ts";
import type { ToolCompletionSource } from "./session.ts";
import { createState, type StateFactory } from "./state.ts";
import { createCatalogResource } from "./catalog-resource.ts";
import {
  type CatalogState,
  createModelCatalog,
  type ModelCatalogOwner,
} from "./model-catalog.ts";
import {
  chooseAgent,
  chooseModel,
  chooseVariant,
  effectiveSelection,
  type PromptChoices,
  type PromptSelection,
  type PromptSelectionContext,
} from "./prompt-selection.ts";
import {
  modelGroups,
  modelKey,
  type ModelPickerGroup,
} from "./model-groups.ts";
import {
  recordRecentModel,
  toggleFavouriteModel,
} from "./model-preferences.ts";

export interface ComposerConnection {
  /** Identity of a welcomed connection, not merely its persistent transport object. */
  key: unknown;
  connected: boolean;
  agents: boolean;
  models: boolean;
}
export type ComposerCatalog<T> = CatalogState<T>;
export interface ComposerSelectionState {
  connected: boolean;
  agents: ComposerCatalog<AgentOption[]>;
  models: ComposerCatalog<ModelCatalog>;
}
export interface ComposerSelectionOptions {
  draft(): Draft;
  change(change: DraftChange): Draft;
  context(): PromptSelectionContext["context"];
  connection(): ComposerConnection;
  load: {
    agents(signal: AbortSignal): Promise<AgentOption[]>;
    models(signal: AbortSignal): Promise<ModelCatalog>;
  };
  prefs: {
    get(): Pick<Preferences, "models.favourite" | "models.recent">;
    set(
      key: "models.favourite" | "models.recent",
      value: ModelRef[],
    ): Promise<unknown>;
  };
  factory?: StateFactory;
  onToolCompleted?: ToolCompletionSource;
  /** Borrow the session's catalog; only standalone consumers create their own. */
  modelCatalog?: ModelCatalogOwner;
}
export interface ComposerSelection {
  state: ComposerSelectionState;
  subscribe(listener: (state: ComposerSelectionState) => void): () => void;
  connect(connection?: ComposerConnection): void;
  dispose(): void;
  ready(): Promise<void>;
  refreshAgents(): Promise<void>;
  refreshModels(): Promise<void>;
  selection(draft?: Draft): PromptSelection;
  groups(): ModelPickerGroup[];
  selectedModelKey(): string | undefined;
  catalogKnown(): boolean;
  chooseAgent(name: string): void;
  chooseModel(model: ModelRef): void;
  chooseVariant(variant: string | undefined): void;
  cycleAgent(delta: number): Promise<void>;
  cycleVariant(): void;
  toggleFavourite(model: ModelRef): Promise<void>;
  recordSent(
    selection: PromptChoices,
    mode: Draft["mode"],
    handled: boolean,
  ): Promise<void>;
}

/** Session-owned next-prompt data and intents, independent of UI and transport. */
export function createComposerSelection(
  options: ComposerSelectionOptions,
): ComposerSelection {
  const models = options.modelCatalog ?? createModelCatalog({
    connection: () => {
      const c = options.connection();
      return { key: c.key, connected: c.connected, available: c.models };
    },
    load: options.load.models,
  });
  const agents = createCatalogResource({
    connection: () => {
      const c = options.connection();
      return { key: c.key, connected: c.connected, available: c.agents };
    },
    load: options.load.agents,
  });
  const current = { connected: false };
  // Like createDrafts, owner data is invocation-current even when a framework
  // publishes its notification later. The factory stores only invalidation.
  const store = (options.factory ?? createState)({ revision: 0 });
  const state: ComposerSelectionState = {
    get connected() {
      void store.state.revision;
      return current.connected;
    },
    get agents() {
      void store.state.revision;
      return agents.state;
    },
    get models() {
      void store.state.revision;
      return models.state;
    },
  };
  const update = (change: (value: typeof current) => void) => {
    change(current);
    store.update((value) => {
      value.revision++;
    });
  };
  let alive = true, generation = 0, connection: ComposerConnection | undefined;
  let changed!: () => void;
  let invalidated = new Promise<void>((resolve) => {
    changed = resolve;
  });
  const stopAgents = agents.subscribe(() => {
    if (alive) update(() => {});
  });
  const stopModels = models.subscribe(() => {
    if (alive) update(() => {});
  });
  const connect = (next = options.connection()) => {
    if (!alive) return;
    if (
      connection && Object.is(next.key, connection.key) &&
      next.connected === connection.connected &&
      next.agents === connection.agents && next.models === connection.models
    ) return;
    connection = { ...next };
    generation++;
    changed();
    invalidated = new Promise<void>((resolve) => {
      changed = resolve;
    });
    update((value) => {
      value.connected = next.connected;
    });
    agents.connect({
      key: next.key,
      connected: next.connected,
      available: next.agents,
    });
    models.connect(
      options.modelCatalog
        ? undefined
        : { key: next.key, connected: next.connected, available: next.models },
    );
  };
  const context = (): PromptSelectionContext => ({
    context: options.context(),
    agents: state.agents.available ? state.agents.value ?? [] : [],
    catalog: state.models.available ? state.models.value : undefined,
  });
  const selection = (draft = options.draft()) =>
    effectiveSelection(draft, context());
  const currentDraft = () => options.change((draft) => draft);
  const ready = async () => {
    while (alive) {
      connect();
      if (!state.connected) return;
      const at = generation;
      await Promise.race([
        Promise.all([agents.ready(), models.ready()]),
        invalidated,
      ]);
      connect();
      if (
        at === generation && !state.agents.loading &&
        !state.models.loading
      ) return;
    }
  };
  let cycles = Promise.resolve(), writes = Promise.resolve();
  const save = (action: () => Promise<unknown>): Promise<void> => {
    const task = writes.then(action).then(() => {});
    writes = task.catch(() => {});
    return task;
  };
  const owner: ComposerSelection = {
    state,
    subscribe: (listener) => store.subscribe(() => listener(state)),
    connect,
    dispose() {
      alive = false;
      stopAgents();
      agents.dispose();
      stopModels();
      if (!options.modelCatalog) models.dispose();
      stopTools?.();
      generation++;
      changed();
    },
    ready,
    refreshAgents() {
      connect();
      return agents.refresh();
    },
    refreshModels() {
      connect();
      return models.refresh();
    },
    selection,
    catalogKnown: () => context().catalog !== undefined,
    groups: () =>
      modelGroups(
        context().catalog,
        options.prefs.get()["models.favourite"],
        options.prefs.get()["models.recent"],
        selection().model.value,
      ),
    selectedModelKey: () => {
      const model = selection().model.value;
      return model && modelKey(model);
    },
    chooseAgent(name) {
      if (alive) options.change((draft) => chooseAgent(draft, name, context()));
    },
    chooseModel(model) {
      if (alive) {
        options.change((draft) => chooseModel(draft, model, context()));
      }
    },
    chooseVariant(variant) {
      if (alive) {
        options.change((draft) => chooseVariant(draft, variant, context()));
      }
    },
    cycleAgent(delta) {
      const task = cycles.then(async () => {
        connect();
        if (!alive || !state.connected || !state.agents.available) {
          return;
        }
        const before = currentDraft(), at = generation;
        await agents.refresh();
        connect();
        if (!alive || at !== generation) return;
        options.change((draft) => {
          if (draft.agent !== before.agent) return draft;
          const input = context(), items = input.agents;
          if (!items.length) return draft;
          const index = Math.max(
            0,
            items.findIndex((agent) =>
              agent.name === selection(draft).agent.value
            ),
          );
          return chooseAgent(
            draft,
            items[(index + delta + items.length) % items.length].name,
            input,
          );
        });
      });
      cycles = task.catch(() => {});
      return task;
    },
    cycleVariant() {
      if (!alive) return;
      options.change((draft) => {
        const current = selection(draft);
        if (!current.applies.variant || !current.model.variants.length) {
          return draft;
        }
        const variants = [undefined, ...current.model.variants];
        return chooseVariant(
          draft,
          variants[
            (variants.indexOf(current.variantChoice) + 1) % variants.length
          ],
          context(),
        );
      });
    },
    toggleFavourite(model) {
      const captured = { ...model };
      return save(() =>
        options.prefs.set(
          "models.favourite",
          toggleFavouriteModel(
            options.prefs.get()["models.favourite"],
            captured,
          ),
        )
      );
    },
    recordSent(sent, mode, handled) {
      if (handled || mode !== "normal" || !sent.model) return Promise.resolve();
      const model = { ...sent.model };
      return save(() =>
        options.prefs.set(
          "models.recent",
          recordRecentModel(options.prefs.get()["models.recent"], model),
        )
      );
    },
  };
  const switched = new Set<string>();
  const stopTools = options.onToolCompleted?.((part) => {
    if (part.call.tool !== "external" || part.call.status !== "completed") {
      return;
    }
    const name = part.call.name === "plan_exit"
      ? "build"
      : part.call.name === "plan_enter"
      ? "plan"
      : undefined;
    if (!name || switched.has(part.id)) return;
    switched.add(part.id);
    // Use exactly the manual intent, including the agent's configured choices.
    // Readiness follows reconnect generations and disposal cancels late intents.
    void ready().then(() => {
      if (alive) owner.chooseAgent(name);
    });
  });
  return owner;
}
