// SPDX-License-Identifier: LGPL-3.0-only
import type { Harness } from "@otk/harness";
import {
  formAnswer,
  type FormRequest,
  type FormsCapability,
  type ServerFrame,
} from "@otk/protocol";
import type { FrameSource } from "../ws/connections.ts";
import type { RpcRegistry } from "../ws/registry.ts";
import { sessionID, text } from "../ws/params.ts";
import {
  nativeEffect,
  nativeExecution,
  readExecution,
} from "../requests/policies.ts";
import { completionReceipt } from "./session-receipts.ts";
/** Pending forms are volatile user-attention state, not a transcript or durable receipt. */
export class FormsFeature implements FrameSource {
  #requests: FormRequest[] = [];
  #listeners = new Set<(frame: ServerFrame) => void>();
  #controller = new AbortController();
  #version = 0;
  #stop: () => void;
  constructor(
    readonly capability: FormsCapability,
    readonly diagnostic: (error: unknown) => void,
  ) {
    this.#stop = capability.watch(() => {
      void this.#refresh().catch((error) => {
        if (!this.#controller.signal.aborted) diagnostic(error);
      });
    });
  }
  async #refresh(): Promise<void> {
    const version = ++this.#version;
    const requests = await this.capability.list({}, this.#controller.signal);
    if (this.#controller.signal.aborted || version !== this.#version) return;
    this.#requests = requests;
    for (const listener of this.#listeners) {
      listener({ t: "forms.pending", requests });
    }
  }
  locations(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const request of this.#requests) {
      if (request.owner.kind === "location") {
        result[request.directory] = (result[request.directory] ?? 0) + 1;
      }
    }
    return result;
  }
  async snapshot(): Promise<ServerFrame> {
    await this.#refresh();
    return { t: "forms.pending", requests: this.#requests };
  }
  listen(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  close(): void {
    this.#controller.abort();
    this.#stop();
    this.#listeners.clear();
  }
}
export function register(rpc: RpcRegistry, harness: Harness): void {
  const capability = harness.capabilities.forms;
  if (!capability) return;
  const replied = completionReceipt("form-replied"),
    cancelled = completionReceipt("form-cancelled");
  rpc.register("form.list", {
    execution: readExecution((
      input: { sessionID?: string; directory?: string },
    ) => input),
    params: (p) => ({
      ...(p.sessionID === undefined ? {} : { sessionID: sessionID(p)! }),
      ...(p.directory === undefined
        ? {}
        : { directory: text(p, "directory")! }),
    }),
    handler: (ctx, input) => capability.list(input, ctx.execution?.signal),
  });
  rpc.register("form.reply", {
    execution: nativeExecution(
      (p: { requestID: string }) => ({ resource: p.requestID }),
      replied,
    ),
    params: (p) => ({
      requestID: text(p, "requestID")!,
      answer: formAnswer(p.answer),
    }),
    handler: (ctx, p) =>
      nativeEffect(ctx, async (operation) => {
        await capability.reply(p.requestID, p.answer, operation);
        return null;
      }, replied),
  });
  rpc.register("form.cancel", {
    execution: nativeExecution(
      (p: { requestID: string }) => ({ resource: p.requestID }),
      cancelled,
    ),
    params: (p) => ({
      requestID: text(p, "requestID")!,
      ...(p.message === undefined
        ? {}
        : { message: text(p, "message", false) }),
    }),
    handler: (ctx, p) =>
      nativeEffect(ctx, async (operation) => {
        await capability.cancel(p.requestID, p.message, operation);
        return null;
      }, cancelled),
  });
}
