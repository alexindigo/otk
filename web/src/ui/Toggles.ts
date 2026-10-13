// SPDX-License-Identifier: LGPL-3.0-only
import { createStore } from "solid-js";
import {
  DEFAULT_PREFS,
  type PreferenceKey,
  type Preferences,
} from "@otk/protocol";
import type { ServerFrame } from "@otk/protocol";
export function createToggles(
  save: (
    key: PreferenceKey,
    value: Preferences[PreferenceKey],
  ) => Promise<unknown>,
) {
  const [state, setState] = createStore({
    prefs: { ...DEFAULT_PREFS },
    ready: false,
    error: "",
  });
  return {
    state,
    receive(frame: ServerFrame): void {
      if (frame.t !== "prefs") return;
      setState((draft) => {
        draft.prefs = frame.prefs;
        draft.ready = true;
        draft.error = "";
      });
    },
    async set(
      key: PreferenceKey,
      value: Preferences[PreferenceKey],
    ): Promise<void> {
      try {
        // The sidecar's ordered broadcast owns state, including concurrent tabs.
        await save(key, value);
      } catch (error) {
        setState((draft) => {
          draft.error = (error as Error).message;
        });
      }
    },
  };
}
