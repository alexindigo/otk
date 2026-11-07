// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContentClock,
  type ContentSession,
  type Message,
  MESSAGE_PAGE_SIZE,
  type MessagePage,
  type MessagePolicy,
} from "@otk/protocol";
export const fixtureMessagePolicy: MessagePolicy = {
  prefetchms: 300000,
  prefetchbytes: 67108864,
  coolms: 300000,
  recoveryconcurrency: 2,
  recoverypending: 128,
  preloadms: 30000,
  concurrency: 4,
  replayops: 128,
  replaybytes: 4194304,
  retryms: 1000,
};
export async function collectMessages(
  core: import("@otk/harness").HarnessCore,
  sessionID: string,
): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;
  do {
    const page = await core.listMessages(sessionID, { before });
    messages.unshift(...page.items);
    before = page.older ?? undefined;
  } while (before !== undefined);
  return messages;
}
/** Explicit whole-history assertion read, through the public cursor contract. */
export async function readRpcMessages(
  client: { rpc<T>(method: string, params: unknown): Promise<T> },
  sessionID: string,
): Promise<Message[]> {
  const messages: Message[] = [];
  let before: string | undefined;
  do {
    const page = await client.rpc<MessagePage>("session.messages", {
      sessionID,
      ...(before ? { before } : {}),
    });
    messages.unshift(...page.items);
    before = page.older ?? undefined;
  } while (before !== undefined);
  return messages;
}
/** Explicit fixture producer for the protocol-15 contract; never used by product code. */
export function fixturePage(
  id: string,
  messages: Message[] = [],
  before?: string,
  session?: ContentSession,
  clock: ContentClock = { epoch: "fixture", seq: 0 },
): MessagePage {
  const end = before === undefined
    ? messages.length
    : Number(before.slice("fixture:".length));
  if (
    !Number.isSafeInteger(end) || end < 0 ||
    (before !== undefined && !before.startsWith("fixture:"))
  ) throw new Error("Invalid fixture cursor");
  const start = Math.max(0, end - MESSAGE_PAGE_SIZE);
  const latest = messages.slice(0, end).findLast((message) =>
    message.role === "user"
  );
  return {
    sessionID: id,
    version: { generation: 0, revision: 0 },
    from: clock,
    clock,
    session: session ??
      {
        id,
        directory: "/project",
        projectID: "project",
        title: id,
        archived: false,
        time: { created: 1, updated: 1 },
      },
    items: messages.slice(start, end),
    older: start ? `fixture:${start}` : null,
    ...(latest?.role === "user"
      ? {
        prompt: {
          id: latest.id,
          agent: latest.agent,
          model: latest.model,
          variant: latest.variant,
        },
      }
      : {}),
    catchup: [],
    turns: {},
    helpers: {},
    recovering: [],
  };
}
