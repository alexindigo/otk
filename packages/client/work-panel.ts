// SPDX-License-Identifier: LGPL-3.0-only
import { createState, type StateFactory, type StateStore } from "./state.ts";

/** An unset turn follows the latest reply with work. */
export interface WorkChoice {
  turn?: string;
  run?: string;
}

export interface WorkShown {
  turn?: string;
  run?: string;
  following: boolean;
  previous?: string;
  next?: string;
}

type SelectionState = {
  choices: Record<string, (WorkChoice & { runTurn?: string }) | undefined>;
};

/** Tab-lifetime selection, independent of the layout and transcript owners. */
export class WorkPanel {
  #store: StateStore<SelectionState>;

  constructor(factory: StateFactory = createState) {
    this.#store = factory({ choices: {} });
  }

  shown(scope: string, turns: readonly string[], live?: string): WorkShown {
    const choice = this.#store.state.choices[scope];
    const pinned = choice?.turn === undefined ? -1 : turns.indexOf(choice.turn);
    const following = pinned === -1;
    const index = following ? turns.length - 1 : pinned;
    const turn = turns[index];
    const run = choice?.runTurn === turn ? choice?.run : undefined;
    return {
      turn,
      run: run ?? (following && turn !== undefined ? live : undefined),
      following,
      previous: turns[index - 1],
      next: turns[index + 1],
    };
  }

  show(
    scope: string,
    { turn, run }: { turn: string; run?: string },
    turns: readonly string[],
  ): void {
    this.#store.update((draft) => {
      draft.choices[scope] = {
        turn: turn === turns.at(-1) ? undefined : turn,
        run,
        // An explicit row on the latest reply must not follow to a new reply.
        runTurn: run === undefined ? undefined : turn,
      };
    });
  }

  step(scope: string, delta: -1 | 1, turns: readonly string[]): void {
    const { previous, next } = this.shown(scope, turns);
    const turn = delta === -1 ? previous : next;
    if (turn !== undefined) this.show(scope, { turn }, turns);
  }

  retire(scope: string): void {
    if (!Object.hasOwn(this.#store.state.choices, scope)) return;
    this.#store.update((draft) => delete draft.choices[scope]);
  }

  clear(): void {
    this.#store.update((draft) => {
      draft.choices = {};
    });
  }
}
