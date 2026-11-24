// SPDX-License-Identifier: LGPL-3.0-only
import {
  ascendingID,
  type Block,
  type Part,
  type PromptPart,
  type UserMessage,
} from "@otk/protocol";
import type { Feedback } from "./failures.ts";
import type { ClientIntent } from "./requests.ts";

/** Local input belongs to its transcript entry, not a view or a receipt notice. */
export interface PendingSend {
  intent: ClientIntent;
  message: UserMessage;
  phase: "pending" | "failed" | "committed";
  /** Captured by SessionDelivery at its dispatch boundary, not inferred by a view. */
  dispatched?: boolean;
  feedback?: Feedback;
  retry?(): void;
}

/** Native-compatible sortable identity, captured alongside the request identity. */
export function pendingMessageID(_intent: ClientIntent): string {
  return ascendingID("msg");
}

export function pendingMessage(
  id: string,
  sessionID: string,
  parts: readonly PromptPart[],
  textBlocks?: (text: string) => Block[],
): UserMessage {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    parts: parts.map((part, index): Part => {
      const key = `local:${id}:${index}`;
      if (part.kind === "text") {
        return {
          id: key,
          kind: "text",
          synthetic: false,
          blocks: textBlocks?.(part.text) ?? [{
            b: "paragraph",
            inline: part.text.split("\n").flatMap((text, n) => [
              ...(n ? [{ i: "break" as const }] : []),
              { i: "text" as const, text },
            ]),
          }],
        };
      }
      if (part.kind === "agent") {
        return { id: key, kind: "agent", name: part.name };
      }
      return {
        id: key,
        kind: "file",
        name: part.source === "path" ? part.label ?? part.path : part.name,
        mime: part.source === "path" ? "application/octet-stream" : part.mime,
        ...(part.source === "path" ? { path: part.path } : {}),
        ...(part.source === "upload"
          ? { url: `data:${part.mime};base64,${part.dataBase64}` }
          : {}),
      };
    }),
  };
}
