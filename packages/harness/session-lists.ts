// SPDX-License-Identifier: LGPL-3.0-only
import type { SessionListInput, SessionMetadata } from "@otk/protocol";
import type { ProviderReadCodec } from "./provider-reads.ts";
export interface SessionListResult {
  items: SessionMetadata[];
  older: string | null;
  generation: string;
}
export interface SessionListReadKinds {
  "sessions.list": {
    input: SessionListInput;
    result: SessionListResult;
    chunk: SessionListResult;
  };
}
export const sessionListReadCodec: ProviderReadCodec<"sessions.list"> = {
  *chunks(value, rows) {
    for (
      let offset = 0;
      offset < value.items.length || offset === 0;
      offset += rows
    ) {
      yield { ...value, items: value.items.slice(offset, offset + rows) };
    }
  },
  create() {
    let value: SessionListResult | undefined;
    return {
      append(chunk) {
        if (
          value &&
          (value.generation !== chunk.generation || value.older !== chunk.older)
        ) {
          throw new Error("Session list authority changed during transfer");
        }
        value = value
          ? { ...value, items: [...value.items, ...chunk.items] }
          : chunk;
      },
      finish() {
        if (!value) throw new Error("Missing session list result");
        return value;
      },
    };
  },
};
