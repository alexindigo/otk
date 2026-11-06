// SPDX-License-Identifier: LGPL-3.0-only
import type {
  HistoryAttachmentRef,
  HistoryEntry,
  PromptPart,
} from "@otk/protocol";
import type { ProviderReadCodec } from "./provider-reads.ts";

export interface HistoryAttachment {
  ref: HistoryAttachmentRef;
  part: Extract<PromptPart, { source: "upload" }>;
}
export interface HistoryReadKinds {
  "history.list": {
    input: { directory?: string };
    result: HistoryEntry[];
    chunk: HistoryEntry[];
  };
  "history.entries": {
    input: { keys: { sessionID: string; messageID: string }[] };
    result: HistoryEntry[];
    chunk: HistoryEntry[];
  };
  "history.attachments": {
    input: { refs: HistoryAttachmentRef[] };
    result: HistoryAttachment[];
    chunk: {
      ref: HistoryAttachmentRef;
      name: string;
      mime: string;
      offset: number;
      size: number;
      dataBase64: string;
      last: boolean;
    } | { empty: true };
  };
}
/** Byte-bounded fragments share the existing publication credits. Offsets are base64 units. */
export const historyAttachmentCodec: ProviderReadCodec<"history.attachments"> =
  {
    *chunks(items) {
      if (!items.length) {
        yield { empty: true };
        return;
      }
      const chars = 64 * 1024;
      for (const { ref, part } of items) {
        for (
          let offset = 0;
          offset < part.dataBase64.length || offset === 0;
          offset += chars
        ) {
          const dataBase64 = part.dataBase64.slice(offset, offset + chars);
          yield {
            ref,
            name: part.name,
            mime: part.mime,
            offset,
            size: part.dataBase64.length,
            dataBase64,
            last: offset + dataBase64.length === part.dataBase64.length,
          };
        }
      }
      // Empty batches bypass read transport at the facade.
    },
    create() {
      const result: HistoryAttachment[] = [];
      let active: {
        ref: HistoryAttachmentRef;
        name: string;
        mime: string;
        size: number;
        chunks: string[];
        length: number;
      } | undefined;
      const seen = new Set<string>();
      return {
        append(chunk) {
          if ("empty" in chunk) {
            if (active || result.length) {
              throw new Error("Invalid empty attachment batch");
            }
            return;
          }
          const key = JSON.stringify(chunk.ref);
          if (!active) {
            if (chunk.offset !== 0 || seen.has(key)) {
              throw new Error("Invalid attachment fragment start");
            }
            seen.add(key);
            active = { ...chunk, chunks: [], length: 0 };
          }
          if (
            JSON.stringify(active.ref) !== key || active.name !== chunk.name ||
            active.mime !== chunk.mime || active.size !== chunk.size ||
            active.length !== chunk.offset ||
            chunk.offset + chunk.dataBase64.length > chunk.size
          ) throw new Error("Invalid attachment fragment continuity");
          active.chunks.push(chunk.dataBase64);
          active.length += chunk.dataBase64.length;
          if (chunk.last) {
            if (active.length !== active.size) {
              throw new Error("Incomplete attachment");
            }
            result.push({
              ref: active.ref,
              part: {
                kind: "file",
                source: "upload",
                name: active.name,
                mime: active.mime,
                dataBase64: active.chunks.join(""),
              },
            });
            active = undefined;
          }
        },
        finish() {
          if (active) throw new Error("Incomplete attachment");
          return result;
        },
      };
    },
  };
