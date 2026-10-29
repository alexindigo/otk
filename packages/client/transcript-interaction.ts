// SPDX-License-Identifier: LGPL-3.0-only
import type { WindowAnchor } from "./window.ts";
export interface TranscriptAnchor extends WindowAnchor {
  messageID?: string;
}

/** Source-free choices survive virtual unmount and body cooling, not deletion. */
export interface TranscriptInteraction {
  disclosure(key: string, generation: string): {
    value(): boolean | undefined;
    set(value: boolean): void;
  };
  retire(key: string): void;
  generation(identity: string): string;
  retireIdentity(identity: string): void;
  measurements(window: string): Map<string, number>;
  anchor(): TranscriptAnchor | undefined;
  anchor(value: TranscriptAnchor | null): void;
  clear(): void;
}
export function createTranscriptInteraction(): TranscriptInteraction {
  const choices = new Map<string, { generation: string; open?: boolean }>();
  const generations = new Map<string, number>();
  const windows = new Map<string, Map<string, number>>();
  let anchor: TranscriptAnchor | undefined;
  return {
    disclosure(key, generation) {
      let value = choices.get(key);
      if (value?.generation !== generation) {
        value = { generation };
        choices.set(key, value);
      }
      const owner = value;
      return {
        value: () => choices.get(key) === owner ? owner.open : undefined,
        set(open) {
          if (choices.get(key) === owner) owner.open = open;
        },
      };
    },
    retire: (key) => {
      choices.delete(key);
    },
    generation: (id) => `${id}:${generations.get(id) ?? 0}`,
    retireIdentity(id) {
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
      generations.clear();
      windows.clear();
      anchor = undefined;
    },
  };
}
