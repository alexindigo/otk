// SPDX-License-Identifier: LGPL-3.0-only
import type { DisclosureCategory, Preferences } from "@otk/protocol";
import {
  createDisclosures,
  type DisclosureKind,
  type Disclosures,
} from "./disclosure.ts";
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
  readonly disclosures: Disclosures;
  defaultFor(
    category: DisclosureCategory,
    prefs?: Partial<Preferences>,
  ): boolean;
  disclosure(kind: DisclosureKind, key: string, generation: string): Disclosure;
  /** Work-log disclosure belongs to the reply's work-log identity;
   * member records only populate the log. */
  workDisclosure(scope: string): Disclosure;
  subscribeWork(scope: string, listener: () => void): () => void;
  retire(key: string): void;
  subscribe(
    listener: () => void,
    kind: DisclosureKind,
    key: string,
    generation: string,
  ): () => void;
  reveal(ancestors: readonly string[]): void;
  generation(identity: string): string;
  retireIdentity(identity: string): void;
  measurements(window: string): Map<string, number>;
  anchor(): TranscriptAnchor | undefined;
  anchor(value: TranscriptAnchor | null): void;
  clear(): void;
}
export function createTranscriptInteraction(
  disclosures: Disclosures = createDisclosures({}),
  scope = "standalone",
): TranscriptInteraction {
  const generations = new Map<string, number>();
  const generation = (id: string) => `${id}:${generations.get(id) ?? 0}`;
  const identify = (id: string, version = generation(id)) => ({
    scope,
    id,
    generation: version,
  });
  const windows = new Map<string, Map<string, number>>();
  let anchor: TranscriptAnchor | undefined;
  const disclosure: TranscriptInteraction["disclosure"] = (
    kind,
    key,
    version,
  ) => {
    const state = disclosures.bind(kind, identify(key, version));
    const value = () => state.chosen() ? state.open() : undefined;
    return {
      value,
      expanded: (category, prefs = {}, required = false) =>
        value() ??
          disclosures.defaultFor(kind, {
            category,
            prefs: () => prefs,
            required: () => required,
          }),
      set(open) {
        void state.set(open);
      },
    };
  };
  return {
    disclosures,
    defaultFor: (category, prefs = {}) =>
      disclosures.defaultFor("recordKinds", { category, prefs: () => prefs }),
    disclosure,
    subscribe(listener, kind, key, version) {
      return disclosures.subscribe(listener, kind, identify(key, version));
    },
    reveal(ancestors) {
      disclosures.reveal("activity", ancestors.map((key) => identify(key)));
    },
    subscribeWork(key, listener) {
      return disclosures.subscribe(listener, "work", identify(key));
    },
    workDisclosure(key) {
      return disclosure("work", key, generation(key));
    },
    retire: (id) => disclosures.retire({ scope, id }),
    generation,
    retireIdentity(id) {
      const previous = generation(id);
      generations.set(id, (generations.get(id) ?? 0) + 1);
      disclosures.retire({ scope, generation: previous });
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
      generations.clear();
      windows.clear();
      anchor = undefined;
      disclosures.retire({ scope });
    },
  };
}
