// SPDX-License-Identifier: LGPL-3.0-only
import { HarnessError } from "@otk/harness";
import {
  type Capabilities,
  type ContentSession,
  type ModelRef,
  type OperationContext,
  OperationFailure,
} from "@otk/protocol";
import type { V2Client } from "./client.ts";
import {
  Messages,
  type NativeMessage,
  type NativeSession,
  SCAN_ROWS,
} from "./messages.ts";
import { mapSession, millis } from "./map.ts";
import { opencodeV2SessionID as ids } from "./ids.ts";
import { readSessionActivity } from "./recency.ts";

/** Selection checkpoints contain metadata only, never command or prompt bodies. */
export async function selectAction(
  client: V2Client,
  raw: NativeSession,
  input: { agent?: string; model?: ModelRef; variant?: string },
  operation?: OperationContext,
): Promise<void> {
  const checkpoint = async () => {
    await operation?.checkpoint("session-selection", {
      kind: "session-selection",
      value: {
        sessionID: ids.encode(raw.id),
        ...(raw.agent ? { agent: raw.agent } : {}),
        ...(raw.model
          ? {
            model: { provider: raw.model.providerID, model: raw.model.id },
            ...(raw.model.variant ? { variant: raw.model.variant } : {}),
          }
          : {}),
      },
    });
  };
  if (input.agent !== undefined && input.agent !== raw.agent) {
    await client.effect(
      (api) =>
        api.session.switchAgent({ sessionID: raw.id, agent: input.agent! }),
      operation,
    );
    raw = { ...raw, agent: input.agent };
    await checkpoint();
  }
  if (
    input.model &&
    (input.model.provider !== raw.model?.providerID ||
      input.model.model !== raw.model?.id ||
      input.variant !== raw.model?.variant)
  ) {
    const model = {
      providerID: input.model.provider,
      id: input.model.model,
      ...(input.variant ? { variant: input.variant } : {}),
    };
    await client.effect(
      (api) => api.session.switchModel({ sessionID: raw.id, model }),
      operation,
    );
    raw = { ...raw, model };
    await checkpoint();
  }
}

/** Bounded pages; only scalar identities and at most 50 previews survive a page. */
export async function revertSession(
  client: V2Client,
  raw: NativeSession,
  signal?: AbortSignal,
): Promise<ContentSession> {
  const mapped = mapSession(raw);
  if (!raw.revert || !mapped.revert) return mapped;
  const messages = new Messages(() => client);
  let cursor: string | undefined, count = 0, foundBoundary = false;
  const prompts: NonNullable<ContentSession["revert"]>["prompts"] = [];
  let boundary: Extract<NativeMessage, { type: "user" }> | undefined;
  do {
    const page = await messages.page(mapped.id, SCAN_ROWS, cursor, signal);
    let found = false;
    for (const message of [...page.items].reverse()) {
      if (message.type === "user") {
        count++;
        prompts.unshift({
          messageID: message.id,
          time: millis(message.time.created),
          preview: message.text.replace(/\s+/g, " ").trim().slice(0, 200),
        });
        if (prompts.length > 50) prompts.pop();
      }
      if (message.id === raw.revert.messageID) {
        foundBoundary = true;
        found = true;
        if (message.type === "user") boundary = message;
        break;
      }
    }
    if (found) break;
    cursor = page.next;
  } while (cursor);
  if (!foundBoundary) {
    throw new OperationFailure(
      "unavailable",
      "native.unavailable",
      new Error("Revert boundary changed during preview acquisition"),
    );
  }
  mapped.revert.messageCount = count;
  mapped.revert.prompts = prompts;
  if (boundary) {
    mapped.revert.prompt = {
      input: boundary.text,
      mode: "normal",
      time: millis(boundary.time.created),
      parts: [
        { kind: "text", text: boundary.text },
        ...(boundary.files ?? []).map((f, index) => ({
          kind: "file" as const,
          source: "history" as const,
          name: f.name ?? "file",
          mime: f.mime,
          size: Math.floor(f.data.length * 3 / 4) -
            (f.data.endsWith("==") ? 2 : f.data.endsWith("=") ? 1 : 0),
          messageID: boundary!.id,
          partID: `file:${index}`,
        })),
      ],
    };
  }
  return mapped;
}

export function sessionActions(ports: {
  client(): V2Client;
  observed(raw: NativeSession): void;
  removed(id: string, operation?: OperationContext): Promise<void>;
}): Pick<
  Capabilities,
  | "sessionActions"
  | "sessionArchive"
  | "revert"
  | "revertCode"
  | "restore"
  | "shell"
> {
  const ordered = <T>(
    id: string,
    operation: OperationContext | undefined,
    run: () => Promise<T>,
  ) => ports.client().sequence(ids.decode(id), run, operation);
  const get = (id: string, operation?: OperationContext) =>
    readSessionActivity(ports.client(), ids.decode(id), operation?.signal);
  const result = async (id: string, operation?: OperationContext) => {
    const raw = await get(id, operation);
    ports.observed(raw);
    return await revertSession(ports.client(), raw, operation?.signal);
  };
  const settleRestore = async (
    id: string,
    after: number,
    operation?: OperationContext,
  ) => {
    const client = ports.client();
    await client.settled(ids.decode(id), operation);
    const settled = await get(id, operation);
    if (
      settled.revert || millis(settled.time.idle) < millis(settled.time.busy) ||
      millis(settled.time.idle) < after
    ) {
      throw new OperationFailure(
        "unknown",
        "native.unknown",
        new Error("Restore execution has not settled"),
      );
    }
    ports.observed(settled);
    return mapSession(settled);
  };
  const stage = (files: boolean) => ({
    async revert(id: string, messageID: string, operation?: OperationContext) {
      return await ordered(id, operation, async () => {
        const client = ports.client();
        await client.effect((api) =>
          api.session.revert.stage({
            sessionID: ids.decode(id),
            messageID,
            files,
          }), operation);
        return await result(id, operation);
      });
    },
  });
  return {
    revert: stage(false),
    revertCode: stage(true),
    restore: {
      settle: (id, after, operation) =>
        ordered(id, operation, () => settleRestore(id, after, operation)),
      async restore(id, operation) {
        return await ordered(id, operation, async () => {
          const client = ports.client(), raw = await get(id, operation);
          if (!raw.revert) return mapSession(raw);
          // Capture the clear-owned execution watermark BEFORE dispatch. Native clear
          // wakes even an empty execution; only wait + fresh terminal clocks settle it.
          const watermark = Math.max(
            millis(raw.time.busy),
            millis(raw.time.idle),
          );
          await operation?.checkpoint("session-boundary-intent", {
            kind: "session-boundary-intent",
            value: {
              sessionID: id,
              messageID: null,
              mode: "restore",
              after: watermark,
            },
          });
          await client.effect(
            (api) => api.session.revert.clear({ sessionID: raw.id }),
            operation,
          );
          return await settleRestore(id, watermark, operation);
        });
      },
    },
    shell: {
      async shell(input, operation) {
        return await ordered(input.sessionID, operation, async () => {
          const client = ports.client(),
            sessionID = ids.decode(input.sessionID);
          await client.effect(
            (api) => api.session.shell({ sessionID, command: input.command }),
            operation,
          );
          // Native shell joins its own shell lifetime before replying. It is not
          // a session execution, so execution.wait cannot certify this effect.
        });
      },
    },
    sessionArchive: {
      async archive(id, archived, operation) {
        return await ordered(id, operation, async () => {
          await ports.client().effect(
            (api) =>
              api.session.update({ sessionID: ids.decode(id), archived }),
            operation,
          );
          return await result(id, operation);
        });
      },
    },
    sessionActions: {
      async rename(id, title, operation) {
        return await ordered(id, operation, async () => {
          await ports.client().effect(
            (api) => api.session.update({ sessionID: ids.decode(id), title }),
            operation,
          );
          return await result(id, operation);
        });
      },
      remove: (id, operation) =>
        ordered(id, operation, () => ports.removed(id, operation)),
      async compact(id, model, operation) {
        return await ordered(id, operation, async () => {
          const client = ports.client(), raw = await get(id, operation);
          await selectAction(client, raw, { model }, operation);
          await client.effect(
            (api) => api.session.compact({ sessionID: raw.id }),
            operation,
          );
          if (operation) await client.settled(raw.id, operation);
        });
      },
      async fork(id, through, operation) {
        return await ordered(id, operation, async () => {
          const client = ports.client(),
            raw = await get(id, operation),
            reader = new Messages(() => client);
          let cursor: string | undefined,
            newer: string | undefined,
            next: string | undefined,
            nextRank = -1,
            cutoffRank = -1,
            rank = 0,
            found = through === undefined,
            older = false;
          do {
            const page = await reader.page(
              id,
              SCAN_ROWS,
              cursor,
              operation?.signal,
            );
            for (const message of [...page.items].reverse()) {
              if (message.id === through) {
                found = true;
                next = newer;
                nextRank = rank - 1;
              }
              if (message.id === raw.revert?.messageID) cutoffRank = rank;
              // Once both scalar boundaries are known, one older message proves
              // a nonempty prefix. No history-sized body or identity array lives.
              if (
                found && (!raw.revert || cutoffRank >= 0) &&
                rank > Math.max(nextRank, cutoffRank)
              ) older = true;
              newer = message.id;
              rank++;
            }
            cursor = page.next;
          } while (cursor && !older);
          if (!found || raw.revert && cutoffRank < 0) {
            throw new OperationFailure(
              "rejected",
              "message",
              new HarnessError(
                "message",
                "That message is no longer available.",
              ),
            );
          }
          const boundary = cutoffRank >= nextRank && raw.revert
            ? raw.revert.messageID
            : next;
          // Native rejects empty-history forks. Prove emptiness before dispatch;
          // never retry an uncertain native fork as a create.
          const empty = rank === 0 || !older;
          const fork = await client.effect(
            (api) =>
              empty
                ? api.session.create({
                  location: raw.location,
                  title: raw.title,
                })
                : api.session.fork({
                  sessionID: raw.id,
                  ...(boundary ? { before: boundary } : {}),
                }),
            operation,
          );
          ports.observed(fork);
          return mapSession(fork);
        });
      },
    },
  };
}
