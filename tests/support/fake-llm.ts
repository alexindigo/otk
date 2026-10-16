// SPDX-License-Identifier: LGPL-3.0-only
export interface Script {
  chunks?: string[];
  reasoning?: string[];
  delay?: number;
  tool?: { name: string; input: Record<string, unknown> };
}
export class FakeLlm {
  readonly requests: Record<string, unknown>[] = [];
  #queue: (Script & { finish?: Promise<void> })[] = [];
  #holds = new Set<() => void>();
  readonly server: Deno.HttpServer;
  readonly port: number;
  constructor() {
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        if (new URL(request.url).pathname === "/v1/models") {
          return Response.json({
            object: "list",
            data: [{ id: "scripted", object: "model", owned_by: "otk" }],
          });
        }
        const body = await request.json();
        this.requests.push(body);
        // opencode's ensureTitle also streams, but owns a separate request.
        // Its explicit instruction identifies it without consuming a main reply.
        const titleRequest = body.messages?.some((
          message: { role: string; content: unknown },
        ) =>
          message.role === "user" && typeof message.content === "string" &&
          message.content.startsWith("Generate a title for this conversation:")
        );
        const script: Script & { finish?: Promise<void> } =
          body.stream && !titleRequest
            ? this.#queue.shift() ?? { chunks: ["Completed."] }
            : { chunks: ["OTK session"] };
        const id = `chatcmpl-${crypto.randomUUID()}`;
        if (!body.stream) {
          return Response.json({
            id,
            object: "chat.completion",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: script.chunks?.join("") || "OTK session",
              },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        }
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (
              delta: unknown,
              finish_reason: string | null = null,
            ) => {
              if (!cancelled) {
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${
                      JSON.stringify({
                        id,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: "scripted",
                        choices: [{ index: 0, delta, finish_reason }],
                      })
                    }\n\n`,
                  ),
                );
              }
            };
            send({ role: "assistant" });
            for (const chunk of script.reasoning ?? []) {
              await new Promise((r) => setTimeout(r, script.delay ?? 5));
              if (cancelled) return;
              send({ reasoning_content: chunk });
            }
            if (script.tool) {
              send({
                tool_calls: [{
                  index: 0,
                  id: `call_${crypto.randomUUID()}`,
                  type: "function",
                  function: {
                    name: script.tool.name,
                    arguments: JSON.stringify(script.tool.input),
                  },
                }],
              });
            }
            for (const chunk of script.chunks ?? []) {
              await new Promise((r) => setTimeout(r, script.delay ?? 5));
              if (cancelled) return;
              send({ content: chunk });
            }
            await script.finish;
            if (cancelled) return;
            send({}, script.tool ? "tool_calls" : "stop");
            if (!cancelled) {
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            }
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    );
    this.port = (this.server.addr as Deno.NetAddr).port;
  }
  queue(...scripts: Script[]): void {
    this.#queue.push(...scripts);
  }
  /** Keep a real reply active until its consumer has exercised the busy state. */
  queueHeld(script: Script): { release(): void } {
    const gate = Promise.withResolvers<void>();
    const release = () => {
      this.#holds.delete(release);
      gate.resolve();
    };
    this.#holds.add(release);
    this.#queue.push({ ...script, finish: gate.promise });
    return { release };
  }
  async stop(): Promise<void> {
    for (const release of this.#holds) release();
    await this.server.shutdown();
  }
}
