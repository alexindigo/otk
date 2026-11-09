// SPDX-License-Identifier: LGPL-3.0-only
import type {
  PrefetchInput,
  PrefetchPage,
  TranscriptFacts,
  TranscriptInput,
} from "./transcript-reads.ts";
declare module "@otk/harness" {
  interface ProviderReadKinds {
    "opcv2.transcript": {
      input: TranscriptInput;
      result: TranscriptFacts;
      chunk: string;
    };
    "opcv2.message.prefetch": {
      input: PrefetchInput;
      result: PrefetchPage;
      chunk: string;
    };
  }
}
