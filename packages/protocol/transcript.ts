// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentOp,
  ContentSession,
  Message,
  ModelRef,
} from "./content.ts";
import type { UsageSummary } from "./digest.ts";

export const MESSAGE_PAGE_SIZE = 10;
export const MAX_MESSAGE_CURSOR_LENGTH = 4096;
/** Space for an empty replay checkpoint and its identity bookkeeping. */
export const MIN_MESSAGE_REPLAY_BYTES = 128;
export type MessageCursor = string;
export interface ContentClock {
  epoch: string;
  seq: number;
}
export interface StreamStamp {
  epoch: string;
  generation: number;
  version: number;
  mode: "replace" | "appendable";
}
export interface LatestPrompt {
  id: string;
  agent?: string;
  model?: ModelRef;
  variant?: string;
}
export interface ReplyBoundary {
  turnID: string;
  firstID?: string;
  lastID?: string;
  complete: boolean;
}
export interface HelperSummary {
  state: "digesting" | "ready" | "unavailable";
  revision: number;
  toolCount: number | null;
  current?: { name: string; title?: string; startedAt?: number };
  time?: { start: number; end?: number };
}
export interface ClockedContent {
  clock: ContentClock;
  event: ContentOp;
}
export interface MessagePage {
  sessionID: string;
  clock: ContentClock;
  from: ContentClock;
  session: ContentSession;
  items: Message[];
  older: MessageCursor | null;
  prompt?: LatestPrompt;
  catchup: ClockedContent[];
  turns: Record<string, { summary?: UsageSummary; boundary: ReplyBoundary }>;
  helpers: Record<string, HelperSummary>;
  recovering: { messageID: string; partID: string; generation: number }[];
}
export interface MessagePageInput {
  sessionID: string;
  before?: MessageCursor;
}
/** Values come only from the composing application's layered config. */
export interface MessagePolicy {
  coolms: number;
  preloadms: number;
  concurrency: number;
  replayops: number;
  replaybytes: number;
  retryms: number;
}
export function messagePolicy(value: unknown): MessagePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid message policy");
  }
  const object = value as Record<string, unknown>;
  const keys = [
    "coolms",
    "preloadms",
    "concurrency",
    "replayops",
    "replaybytes",
    "retryms",
  ] as const;
  if (
    Object.keys(object).some((key) =>
      !keys.includes(key as typeof keys[number])
    )
  ) {
    throw new TypeError("Unknown message policy field");
  }
  for (const key of keys) {
    if (!Number.isSafeInteger(object[key]) || Number(object[key]) <= 0) {
      throw new TypeError(`messages.${key}: expected positive safe integer`);
    }
  }
  if (Number(object.replaybytes) < MIN_MESSAGE_REPLAY_BYTES) {
    throw new TypeError(
      `messages.replaybytes: must hold ${MIN_MESSAGE_REPLAY_BYTES} bookkeeping bytes`,
    );
  }
  return {
    coolms: Number(object.coolms),
    preloadms: Number(object.preloadms),
    concurrency: Number(object.concurrency),
    replayops: Number(object.replayops),
    replaybytes: Number(object.replaybytes),
    retryms: Number(object.retryms),
  };
}
