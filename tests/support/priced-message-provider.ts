// SPDX-License-Identifier: LGPL-3.0-only
import { serve } from "./http.ts";
import { resources } from "./resources.ts";
import { nativeKind } from "./native.ts";
/** Same native priced streaming provider as the legacy U4 journey. */
export function pricedMessageProvider() {
  let step = 0;
  const provider = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const body = await request.json(),
        title = JSON.stringify(body.messages).includes(
          "Generate a title for this conversation:",
        ),
        n = title ? 1 : ++step,
        tool = !title && n <= 2;
      const delta = tool
        ? {
          tool_calls: [{
            index: 0,
            id: `call_usage_${n}`,
            type: "function",
            function: {
              name: nativeKind === "opencode-v2-server" ? "shell" : "bash",
              arguments: JSON.stringify({
                command: n === 1 ? "pwd" : "ls -la",
                description: n === 1
                  ? "Read the directory"
                  : "List directory files",
              }),
            },
          }],
        }
        : {
          content: title
            ? "Usage"
            : n === 3
            ? "Turn usage includes both steps."
            : "Another turn has its own usage.",
        };
      const chunk = (delta: unknown, finish_reason: string | null = null) =>
        `data: ${
          JSON.stringify({
            id: `usage-${n}`,
            object: "chat.completion.chunk",
            model: "priced",
            choices: [{ index: 0, delta, finish_reason }],
          })
        }\n\n`;
      return new Response(
        chunk({ role: "assistant" }) + chunk(delta) +
          chunk({}, tool ? "tool_calls" : "stop") + `data: ${
          JSON.stringify({
            id: `usage-${n}`,
            object: "chat.completion.chunk",
            choices: [],
            usage: {
              prompt_tokens: n * 100000,
              completion_tokens: n * 10000,
              total_tokens: n * 110000,
              prompt_tokens_details: { cached_tokens: n * 20000 },
              completion_tokens_details: { reasoning_tokens: n * 2000 },
            },
          })
        }\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  );
  resources().defer("priced message provider", () => provider.shutdown());
  return {
    port: provider.addr.port,
    config: {
      model: "priced/priced",
      provider: {
        priced: {
          npm: "@ai-sdk/openai-compatible",
          name: "Priced provider",
          options: {
            baseURL: `http://127.0.0.1:${provider.addr.port}/v1`,
            apiKey: "fixture",
          },
          models: {
            priced: {
              name: "Priced model",
              limit: { context: 1000000, output: 100000 },
              cost: { input: 2, output: 4, cache_read: .5, cache_write: 3 },
            },
          },
        },
      },
    },
  };
}
