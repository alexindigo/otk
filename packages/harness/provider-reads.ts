// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionIdentity } from "./types.ts";
import type { HistoryReadKinds } from "./history-reads.ts";
import type { ClockReadKinds } from "./clock-reads.ts";
import type { SessionListReadKinds } from "./session-lists.ts";
import type {
  AgentReadKinds,
  CommandReadKinds,
  FileReadKinds,
  ModelReadKinds,
  QuestionReadKinds,
  ResourceReadKinds,
  SkillReadKinds,
} from "./catalog-reads.ts";
export interface IdentityReadKinds {
  "identity.batch": {
    input: { ids: string[] };
    result: SessionIdentity[];
    chunk: SessionIdentity[];
  };
}
/** Feature contributions share the digest sink's executor and volatile transport. */
export interface ProviderReadKinds
  extends
    IdentityReadKinds,
    SessionListReadKinds,
    HistoryReadKinds,
    ClockReadKinds,
    AgentReadKinds,
    CommandReadKinds,
    SkillReadKinds,
    ModelReadKinds,
    ResourceReadKinds,
    FileReadKinds,
    QuestionReadKinds {}
export interface ProviderReadOptions {
  optional?: boolean;
  owner: string;
  priority: "user" | "attention" | "visible" | "background";
  signal?: AbortSignal;
}
export interface ProviderReadPort {
  read<K extends keyof ProviderReadKinds>(
    kind: K,
    input: ProviderReadKinds[K]["input"],
    options: ProviderReadOptions,
  ): Promise<ProviderReadKinds[K]["result"]>;
  release(owner: string): void;
}
export type ProviderReaders = {
  [K in keyof ProviderReadKinds]?: (
    input: ProviderReadKinds[K]["input"],
    signal: AbortSignal,
  ) => Promise<ProviderReadKinds[K]["result"]>;
};
export interface ProviderReadCodec<K extends keyof ProviderReadKinds> {
  chunks(
    value: ProviderReadKinds[K]["result"],
    rows: number,
  ): Iterable<ProviderReadKinds[K]["chunk"]>;
  create(): {
    append(chunk: ProviderReadKinds[K]["chunk"]): void;
    finish(): ProviderReadKinds[K]["result"];
  };
}
export type ProviderReadCodecs = {
  [K in keyof ProviderReadKinds]?: ProviderReadCodec<K>;
};
/** Shared array framing; each feature selects its own typed contribution. */
export function arrayReadCodec<T>(): {
  chunks(value: T[], rows: number): Iterable<T[]>;
  create(): { append(chunk: T[]): void; finish(): T[] };
} {
  return {
    *chunks(value, rows) {
      for (
        let offset = 0;
        offset < value.length || offset === 0;
        offset += rows
      ) yield value.slice(offset, offset + rows);
    },
    create() {
      const values: T[] = [];
      return {
        append: (chunk) => {
          for (const item of chunk) values.push(item);
        },
        finish: () => values,
      };
    },
  };
}
/** Identity's array codec is selected by composition, never by transport dispatch. */
export const identityReadCodec: ProviderReadCodec<"identity.batch"> = {
  *chunks(value, rows) {
    for (
      let offset = 0;
      offset < value.length || offset === 0;
      offset += rows
    ) yield value.slice(offset, offset + rows);
  },
  create() {
    const values: SessionIdentity[] = [];
    return { append: (chunk) => values.push(...chunk), finish: () => values };
  },
};
