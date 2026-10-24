// SPDX-License-Identifier: LGPL-3.0-only
import { normalizeError } from "@otk/protocol";
import type { ClientFrame, ServerFrame } from "@otk/protocol";
import { checkClientFrameSize } from "@otk/protocol";
import type { RpcMethod, RpcParams, RpcResult } from "@otk/protocol";

export class Rpc {
  #next = 0;
  #pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      cleanup(): void;
    }
  >();
  constructor(readonly send: (frame: ClientFrame) => void) {}
  call<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
    signal?: AbortSignal,
  ): Promise<RpcResult<M>> {
    return new Promise<RpcResult<M>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("Request cancelled"));
        return;
      }
      const id = String(++this.#next);
      const fail = (error: Error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        reject(error);
      };
      const abort = () => fail(new Error("Request cancelled"));
      const timer = setTimeout(
        () => fail(new Error(`${method} timed out`)),
        30_000,
      );
      this.#pending.set(id, {
        resolve: (value) => resolve(value as RpcResult<M>),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const frame: ClientFrame = { t: "rpc", id, method, params };
        checkClientFrameSize(JSON.stringify(frame));
        this.send(frame);
      } catch (error) {
        fail(normalizeError(error));
      }
    });
  }
  receive(frame: ServerFrame): void {
    if (frame.t !== "rpc.result") return;
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    pending.cleanup();
    if (frame.ok) pending.resolve(frame.result);
    else pending.reject(new Error(frame.error.message));
  }
  close(): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Sidecar disconnected"));
    }
    this.#pending.clear();
  }
}
