// SPDX-License-Identifier: LGPL-3.0-only
import { arrayReadCodec, type ProviderReadCodec } from "@otk/harness";
import type { SessionFacts } from "./metadata.ts";
declare module "@otk/harness" {
  interface ProviderReadKinds {
    "opcv2.sessions": {
      input: { ids: string[] };
      result: SessionFacts[];
      chunk: SessionFacts[];
    };
  }
}
export const scalarSessionReadCodec: ProviderReadCodec<"opcv2.sessions"> =
  arrayReadCodec<SessionFacts>();
