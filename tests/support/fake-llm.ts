// SPDX-License-Identifier: LGPL-3.0-only
import { resources } from "./resources.ts";
export interface Script {
  chunks?: string[];
  reasoning?: string[];
  delay?: number;
  tool?: { name: string; input: Record<string, unknown> };
}
export class FakeLlm {
  readonly requests: Record<string, unknown>[] = [];
  #queue: (Script & {
    finish?: Promise<void>;
    beforeChunk?: (index: number) => Promise<void>;
  })[] = [];
  #holds = new Set<() => void>();
  #active = 0;
  #strict = false;
  #unexpected = 0;
  #requestLog?: string;
  recordRequests(path: string): void {
    this.#requestLog = path;
    Deno.writeTextFileSync(path, JSON.stringify(this.requests, null, 2));
  }
  get pending(): number {
    return this.#queue.length;
  }
  get active(): number {
    return this.#active;
  }
  get unexpected(): number {
    return this.#unexpected;
  }
  strict(): void {
    this.#strict = true;
  }
  releaseAll(): void {
    for (const release of [...this.#holds]) release();
  }
  readonly server: Deno.HttpServer;
  readonly port: number;
  #stop: () => Promise<void>;
  constructor() {
    const scope = resources();
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
        if (this.#requestLog) {
          Deno.writeTextFileSync(
            this.#requestLog,
            JSON.stringify(this.requests, null, 2),
          );
        }
        // Native title generation owns a separate reply on both protocols.
        // Match its instructions, never the user's ordinary prompt content.
        const titleRequest = body.messages?.some((
          message: { role: string; content: unknown },
        ) =>
          typeof message.content === "string" &&
          ((message.role === "user" &&
            message.content.startsWith(
              "Generate a title for this conversation:",
            )) ||
            (message.role === "system" && message.content.startsWith(
              "You name conversations so the user can find them later in a list of past sessions.",
            )))
        );
        if (
          this.#strict && body.stream && !titleRequest && !this.#queue.length
        ) {
          this.#unexpected++;
        }
        const script: Script & {
          finish?: Promise<void>;
          beforeChunk?: (index: number) => Promise<void>;
        } = body.stream && !titleRequest
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
        this.#active++;
        let settled = false;
        const settle = () => {
          if (!settled) {
            settled = true;
            this.#active--;
          }
        };
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            try {
              // A consumer-owned gate is not a stalled provider. SSE comments
              // preserve that lifetime without generating model content/events.
              const waitForConsumer = async (gate?: Promise<void>) => {
                if (!gate) return;
                heartbeat = setInterval(() => {
                  if (!cancelled) {
                    controller.enqueue(new TextEncoder().encode(": held\n\n"));
                  }
                }, 1000);
                try {
                  await gate;
                } finally {
                  clearInterval(heartbeat);
                  heartbeat = undefined;
                }
              };
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
              for (const [index, chunk] of (script.chunks ?? []).entries()) {
                await waitForConsumer(script.beforeChunk?.(index));
                await new Promise((r) => setTimeout(r, script.delay ?? 5));
                if (cancelled) return;
                send({ content: chunk });
              }
              await waitForConsumer(script.finish);
              if (cancelled) return;
              send({}, script.tool ? "tool_calls" : "stop");
              if (!cancelled) {
                controller.enqueue(
                  new TextEncoder().encode("data: [DONE]\n\n"),
                );
                controller.close();
              }
            } finally {
              settle();
            }
          },
          cancel() {
            cancelled = true;
            clearInterval(heartbeat);
            settle();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    );
    this.port = (this.server.addr as Deno.NetAddr).port;
    this.#stop = scope.defer("scripted provider", async () => {
      for (const release of this.#holds) release();
      await this.server.shutdown();
    });
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
  /** Consumer-acknowledged chunk delivery; no scheduler-sized observation window. */
  queueStepped(script: Script): { next(): void } {
    const gates = (script.chunks ?? []).map(() =>
      Promise.withResolvers<void>()
    );
    let index = 0;
    const release = () => {
      this.#holds.delete(release);
      for (const gate of gates) gate.resolve();
    };
    this.#holds.add(release);
    this.#queue.push({ ...script, beforeChunk: (n) => gates[n].promise });
    return {
      next: () => {
        if (index >= gates.length) {
          throw new Error("No remaining scripted chunk");
        }
        gates[index++].resolve();
        if (index === gates.length) this.#holds.delete(release);
      },
    };
  }
  async stop(): Promise<void> {
    await this.#stop();
  }
}
