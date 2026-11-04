// SPDX-License-Identifier: LGPL-3.0-only
import type { AssistantMessage, Message, ModelCatalog } from "@otk/protocol";

/** Fixed public usage inputs, shared by paint and accessible-value probes. */
export function themeUsage(sessionID: string) {
  const call = (i: number, cost: number | null = .43): AssistantMessage => ({
    id: `usage-${i}`,
    sessionID,
    role: "assistant",
    replyTo: "usage-prompt",
    agent: "build",
    model: { provider: "priced", model: "model" },
    time: { created: i * 1000 + 2, completed: i * 1000 + 902 },
    tokens: {
      input: 100,
      output: 20,
      reasoning: 30,
      cache: { read: 40, write: 50 },
    },
    cost,
    interrupted: false,
    parts: [{
      id: `usage-tool-${i}`,
      kind: "tool",
      call: {
        tool: "bash",
        callID: `usage-tool-${i}`,
        status: "completed",
        awaitingPermission: false,
        time: { start: i * 1000 + 2, end: i * 1000 + 802 },
        title:
          "Inspect every affected consumer and the complete dependency graph "
            .repeat(8),
        command: "pwd",
        output: "/project",
      },
    }, {
      id: `usage-text-${i}`,
      kind: "text",
      synthetic: false,
      blocks: [{
        b: "paragraph",
        inline: [{ i: "text", text: "Fixed usage call " + i }],
      }],
    }],
  });
  const prompt: Message = {
    id: "usage-prompt",
    sessionID,
    role: "user",
    time: { created: 1 },
    parts: [],
  };
  const collection = (
    count: number,
  ): Message[] => [prompt, ...Array.from({ length: count }, (_, i) => call(i))];
  const money = Object.fromEntries(
    [0, .00000005, .0096, .01, 1.2, 1234.567].map((
      amount,
      i,
    ) => [`usage-money-${i}`, [prompt, {
      ...call(0, amount),
      tokens: {
        input: 100,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }]]),
  );
  return {
    collections: {
      "usage-small": collection(3),
      "usage-long": collection(120),
      "usage-unknown": [prompt, {
        ...call(0, null),
        model: { provider: "unknown", model: "model" },
      }],
      "usage-unreported": [prompt, {
        ...call(0, null),
        model: { provider: "unknown", model: "model" },
        tokens: {
          input: null,
          output: null,
          reasoning: null,
          cache: { read: null, write: null },
        },
      }],
      "usage-queued": [prompt, call(0), {
        ...prompt,
        id: "queued-usage",
        time: { created: 500 },
      }, { ...call(1), model: { provider: "second", model: "model" } }],
      ...money,
    } satisfies Record<string, Message[]>,
    catalog: {
      defaultState: "unknown",
      providers: ["priced", "second"].map((id, i) => ({
        id,
        name: id +
          " provider for the complete dependency graph and every affected consumer"
            .repeat(3),
        models: [{
          id: "model",
          name: "Long model name " + "with provider details ".repeat(12),
          variants: [],
          status: "active",
          free: false,
          cost: {
            input: (i + 1) * 2,
            output: (i + 1) * 4,
            cache: { read: (i + 1) * .5, write: (i + 1) * 3 },
          },
        }],
      })),
    } satisfies ModelCatalog,
  };
}
