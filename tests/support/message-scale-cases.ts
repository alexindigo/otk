// SPDX-License-Identifier: LGPL-3.0-only
/** Source fixture inputs, independent of OTK's mappers, reducers and digest. */
export const MESSAGE_CASES = {
  giant: 7,
  helper: 8,
  code: 9,
  diff: 41,
  queued: 42,
};
export const PAYLOAD_BYTES = 16 * 1024 * 1024;
export interface MessageScaleOptions {
  messages?: boolean;
  payload?: boolean;
}
export function scaleRole(session: number, rank: number, messages = false) {
  if (messages && session === MESSAGE_CASES.giant) {
    return rank ? "assistant" : "user";
  }
  if (messages && session === MESSAGE_CASES.queued && rank >= 98) return "user";
  return rank % 2 ? "assistant" : "user";
}
export function scaleSource(
  session: number,
  rank: number,
  part: number,
  payload = false,
): string {
  const marker = `Scale fixture ${session}/${rank}/${part}`;
  if (payload && session === 0 && part === 0) {
    // Distinct deterministic ASCII source per message. At least 16MiB across
    // the session, without shared repeated backing strings as a false heap proof.
    let value = marker + "\n";
    for (let n = 0; value.length < Math.ceil(PAYLOAD_BYTES / 1525); n++) {
      value += `${rank.toString(36)}_${n.toString(36)}_${
        ((rank + 1) * (n + 17) % 1000003).toString(36)
      } `;
    }
    return value;
  }
  return marker;
}
export function scaleParts(
  session: number,
  rank: number,
  part: number,
  directory: string,
  options: MessageScaleOptions,
): Record<string, unknown> {
  const text = scaleSource(session, rank, part, options.payload);
  if (options.payload && session === 0 && rank === 1524 && part === 0) {
    return { type: "text", text: "```ts\n// " + text + "\n```" };
  }
  if (!options.messages || part || rank % 2 === 0) {
    return { type: "text", text };
  }
  if (session === MESSAGE_CASES.code) {
    return {
      type: "text",
      text: "```ts\n" + Array.from({ length: 2048 }, (_, line) =>
        `const line_${rank}_${line} = ${line};`).join("\n") +
        "\n```",
    };
  }
  if (session === MESSAGE_CASES.helper) {
    return {
      type: "tool",
      callID: `helper-${rank}`,
      tool: "task",
      state: {
        status: "completed",
        input: {
          description: `Scale helper ${rank}`,
          subagent_type: "general",
          prompt: "Inspect",
        },
        output: text,
        title: "Inspect scale helper",
        metadata: { sessionId: "ses_scale000000" },
        time: {
          start: 1700000000000 + rank * 10,
          end: 1700000000005 + rank * 10,
        },
      },
    };
  }
  if (session === MESSAGE_CASES.diff) {
    const path = directory + "/scale.ts";
    const patch = `--- a/scale.ts\n+++ b/scale.ts\n@@ -0,0 +1,1000 @@\n` +
      Array.from(
        { length: 1000 },
        (_, line) => `+const added_${line} = ${line};`,
      ).join("\n") + "\n";
    return {
      type: "tool",
      callID: `diff-${rank}`,
      tool: "edit",
      state: {
        status: "completed",
        input: { filePath: path, oldString: "", newString: "fixture" },
        output: text,
        title: "scale.ts",
        metadata: {
          diff: patch,
          filediff: { file: path, patch, additions: 1000, deletions: 0 },
          diagnostics: {},
        },
        time: {
          start: 1700000000000 + rank * 10,
          end: 1700000000005 + rank * 10,
        },
      },
    };
  }
  return { type: "text", text };
}
