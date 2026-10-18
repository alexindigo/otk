// SPDX-License-Identifier: LGPL-3.0-only
import type {
  AgentOption,
  ModelCatalog,
  ModelRef,
  Preferences,
} from "@otk/protocol";
import type { Draft, DraftChange } from "./drafts.ts";
import { createState, type StateFactory } from "./state.ts";
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
export interface ComposerCatalog<T> {
  value?: T;
  available: boolean;
  loading: boolean;
  error: string;
}
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
  load: { agents(): Promise<AgentOption[]>; models(): Promise<ModelCatalog> };
  prefs: {
    get(): Pick<Preferences, "models.favourite" | "models.recent">;
    set(
      key: "models.favourite" | "models.recent",
      value: ModelRef[],
    ): Promise<unknown>;
  };
  factory?: StateFactory;
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
  const current: ComposerSelectionState = {
    connected: false,
    agents: { available: false, loading: false, error: "" },
    models: { available: false, loading: false, error: "" },
  };
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
      return current.agents;
    },
    get models() {
      void store.state.revision;
      return current.models;
    },
  };
  const update = (change: (value: ComposerSelectionState) => void) => {
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
  function resource<T>(
    read: () => ComposerCatalog<T>,
    write: (change: (catalog: ComposerCatalog<T>) => void) => void,
    load: () => Promise<T>,
  ) {
    let pending: { generation: number; work: Promise<void> } | undefined;
    let attempted = -1;
    const refresh = (): Promise<void> => {
      if (!alive || !state.connected || !read().available) {
        return Promise.resolve();
      }
      if (pending?.generation === generation) return pending.work;
      const at = generation;
      attempted = at;
      write((catalog) => {
        catalog.loading = true;
        catalog.error = "";
      });
      const work = Promise.resolve().then(load).then((value) => {
        connect();
        if (alive && generation === at) {
          write((catalog) => {
            catalog.value = value;
          });
        }
      }).catch((error: unknown) => {
        connect();
        if (alive && generation === at) {
          write((catalog) => {
            catalog.error = (error as Error).message;
          });
        }
      }).finally(() => {
        if (alive && generation === at) {
          pending = undefined;
          write((catalog) => {
            catalog.loading = false;
          });
        }
      });
      pending = { generation: at, work };
      return work;
    };
    return {
      refresh,
      ensure: () =>
        pending?.generation === generation
          ? pending.work
          : attempted === generation
          ? Promise.resolve()
          : refresh(),
      reset() {
        pending = undefined;
        attempted = -1;
        write((catalog) => {
          catalog.loading = false;
          catalog.error = "";
        });
      },
    };
  }
  const agents = resource(
    () => state.agents,
    (fn) =>
      update((value) => {
        value.agents = { ...value.agents };
        fn(value.agents);
      }),
    options.load.agents,
  );
  const models = resource(
    () => state.models,
    (fn) =>
      update((value) => {
        value.models = { ...value.models };
        fn(value.models);
      }),
    options.load.models,
  );
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
      value.agents = { ...value.agents, available: next.agents };
      value.models = { ...value.models, available: next.models };
    });
    agents.reset();
    models.reset();
    void agents.refresh();
    void models.refresh();
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
        Promise.all([agents.ensure(), models.ensure()]),
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
  return {
    state,
    subscribe: (listener) => store.subscribe(() => listener(state)),
    connect,
    dispose() {
      alive = false;
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
            (variants.indexOf(current.variant.value) + 1) % variants.length
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
}
