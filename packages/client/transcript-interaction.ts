// SPDX-License-Identifier: LGPL-3.0-only
import {
  DEFAULT_PREFS,
  type DisclosureCategory,
  type Preferences,
} from "@otk/protocol";
import type { WindowAnchor } from "./window.ts";
export interface TranscriptAnchor extends WindowAnchor {
  messageID?: string;
}

interface Disclosure {
  value(): boolean | undefined;
  expanded(
    category: DisclosureCategory,
    prefs?: Partial<Preferences>,
    required?: boolean,
  ): boolean;
  set(value: boolean): void;
}

/** Source-free choices survive virtual unmount and body cooling, not deletion. */
export interface TranscriptInteraction {
  defaultFor(
    category: DisclosureCategory,
    prefs?: Partial<Preferences>,
  ): boolean;
  disclosure(key: string, generation: string): Disclosure;
  /** Work-log disclosure belongs to the reply's work-log identity;
   * member records only populate the log. */
  workDisclosure(scope: string): Disclosure;
  subscribeWork(scope: string, listener: () => void): () => void;
  retire(key: string): void;
  subscribe(listener: () => void, key: string): () => void;
  reveal(ancestors: readonly string[]): void;
  generation(identity: string): string;
  retireIdentity(identity: string): void;
  measurements(window: string): Map<string, number>;
  anchor(): TranscriptAnchor | undefined;
  anchor(value: TranscriptAnchor | null): void;
  clear(): void;
}
export function createTranscriptInteraction(): TranscriptInteraction {
  const choices = new Map<string, { generation: string; open?: boolean }>();
  type WorkIntent = { open: boolean };
  const workIntents = new Map<string, WorkIntent>();
  const workKey = (scope: string) => JSON.stringify(["work", scope]);
  const workIntentKey = (scope: string, generation: string) =>
    JSON.stringify([workKey(scope), generation]);
  let lifetime = 0;
  const generations = new Map<string, number>();
  const windows = new Map<string, Map<string, number>>();
  const listeners = new Map<string, Set<() => void>>();
  const publish = (key: string) => {
    for (const listener of listeners.get(key) ?? []) listener();
  };
  let anchor: TranscriptAnchor | undefined;
  const defaultFor = (
    category: DisclosureCategory,
    prefs: Partial<Preferences> = {},
  ) => {
    const defaults = { ...DEFAULT_PREFS, ...prefs };
    const categories: Record<DisclosureCategory, boolean> = {
      work: defaults.expandWork,
      toolOutput: defaults.expandToolOutput,
      reasoning: defaults.thinking === "show",
      fileChanges: !defaults.collapseFileChanges,
      system: defaults.expandSystem,
      delegation: defaults.expandDelegation,
      outgoing: defaults.expandOutgoing,
      compaction: defaults.expandCompaction,
      record: defaults.expandRecords,
      stepMarkers: defaults.expandStepMarkers,
      snapshots: defaults.expandSnapshots,
      source: defaults.expandSource,
    };
    return categories[category];
  };
  return {
    defaultFor,
    subscribe(listener, key) {
      let selected = listeners.get(key);
      if (!selected) listeners.set(key, selected = new Set());
      selected.add(listener);
      return () => {
        selected.delete(listener);
        if (!selected.size) listeners.delete(key);
      };
    },
    reveal(ancestors) {
      for (const key of ancestors) {
        choices.set(key, {
          generation: `${key}:${generations.get(key) ?? 0}`,
          open: true,
        });
        publish(key);
      }
    },
    disclosure(key, generation) {
      let value = choices.get(key);
      if (value?.generation !== generation) {
        value = { generation };
        choices.set(key, value);
      }
      return {
        value: () =>
          choices.get(key)?.generation === generation
            ? choices.get(key)?.open
            : undefined,
        expanded: (category, prefs, required = false) =>
          (choices.get(key)?.generation === generation
            ? choices.get(key)?.open
            : undefined) ??
            (required || defaultFor(category, prefs)),
        set(open) {
          if (choices.get(key)?.generation === generation) {
            choices.get(key)!.open = open;
            publish(key);
          }
        },
      };
    },
    subscribeWork(scope, listener) {
      return this.subscribe(listener, workKey(scope));
    },
    workDisclosure(scope) {
      const generation = this.generation(scope);
      const key = workIntentKey(scope, generation);
      const epoch = lifetime;
      const current = () =>
        epoch === lifetime && generation === this.generation(scope);
      const value = () => current() ? workIntents.get(key)?.open : undefined;
      return {
        value,
        expanded: (category, prefs, required = false) =>
          value() ?? (required || defaultFor(category, prefs)),
        set(open) {
          if (!current()) return;
          workIntents.set(key, { open });
          publish(workKey(scope));
        },
      };
    },
    retire: (key) => {
      choices.delete(key);
    },
    generation: (id) => `${id}:${generations.get(id) ?? 0}`,
    retireIdentity(id) {
      workIntents.delete(workIntentKey(id, this.generation(id)));
      generations.set(id, (generations.get(id) ?? 0) + 1);
    },
    measurements(window) {
      let sizes = windows.get(window);
      if (!sizes) {
        sizes = new Map();
        windows.set(window, sizes);
      }
      return sizes;
    },
    anchor(value?: TranscriptAnchor | null) {
      if (value === null) anchor = undefined;
      if (value) {
        anchor = {
          key: value.key,
          offset: value.offset,
          ...(value.messageID === undefined
            ? {}
            : { messageID: value.messageID }),
        };
      }
      return anchor && { ...anchor };
    },
    clear() {
      choices.clear();
      workIntents.clear();
      lifetime++;
      generations.clear();
      windows.clear();
      anchor = undefined;
    },
  };
}
