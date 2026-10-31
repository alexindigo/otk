// SPDX-License-Identifier: LGPL-3.0-only
import type { ProviderReadCodec } from "./provider-reads.ts";
export interface ClockReadKinds {
  "message.clock": {
    input: { sessionID: string; messageID: string };
    result: { lastOutput: number | null };
    chunk: { lastOutput: number | null };
  };
}
export const clockReadCodec: ProviderReadCodec<"message.clock"> = {
  *chunks(value) {
    yield value;
  },
  create() {
    let result: { lastOutput: number | null } | undefined;
    return {
      append(value) {
        if (result) throw new Error("Duplicate clock result");
        result = value;
      },
      finish() {
        if (!result) throw new Error("Missing clock result");
        return result;
      },
    };
  },
};
