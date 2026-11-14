// SPDX-License-Identifier: LGPL-3.0-only
import type {
  PrefetchInput,
  PrefetchPage,
  TranscriptFacts,
  TranscriptInput,
} from "./transcript-reads.ts";
declare module "@otk/harness" {
  interface ProviderReadKinds {
    "opcv2.helper.progress": {
      input: { sessionID: string };
      result: import("@otk/protocol").HelperSummary;
      chunk: string;
    };
    "opcv2.transcript": {
      input: TranscriptInput;
      result: TranscriptFacts;
      chunk: string;
    };
    "opcv2.request.anchor": {
      input: { sessionID: string; messageID?: string };
      result: { seq?: number };
      chunk: string;
    };
    "opcv2.message.prefetch": {
      input: PrefetchInput;
      result: PrefetchPage;
      chunk: string;
    };
  }
}
