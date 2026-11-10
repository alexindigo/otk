// SPDX-License-Identifier: LGPL-3.0-only
import { randomUUID } from "node:crypto";
import type { Json, TestLease } from "../../support/fixture-control.ts";
import { test as workerTest } from "./stack.ts";
import { Controller } from "./protocol.ts";
import type { RpcMethod, RpcParams, RpcResult } from "@otk/protocol";
import type { Browser, BrowserContext, TestInfo } from "@playwright/test";

export class TestState {
  readonly #contexts: BrowserContext[] = [];
  get contexts(): readonly BrowserContext[] {
    return this.#contexts;
  }
  constructor(
    readonly controller: Controller,
    readonly lease: TestLease,
    context?: BrowserContext,
  ) {
    if (context) this.#contexts.push(context);
  }
  get directory(): string {
    return this.lease.directory;
  }
  get url(): string {
    return this.controller.info!.url;
  }
  sessionID(nativeID: string): string {
    return `opcv${
      this.controller.info!.version.startsWith("2.") ? "2" : "1"
    }-${nativeID}`;
  }
  async newContext(browser: Browser): Promise<BrowserContext> {
    const context = await browser.newContext();
    this.#contexts.push(context);
    return context;
  }
  product<M extends RpcMethod>(
    method: M,
    params: RpcParams<M>,
  ): Promise<RpcResult<M>> {
    return this.controller.rpc(this.lease.lease, method, params);
  }
  native<T>(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    body?: Json,
  ): Promise<T> {
    return this.controller.call("nativeRequest", {
      lease: this.lease.lease,
      path,
      method,
      ...(body === undefined ? {} : { body }),
    });
  }
  queue(
    chunks: string[],
    gate?: "held" | "stepped",
  ): Promise<{ gate: string }> {
    return this.controller.call("queueScript", {
      lease: this.lease.lease,
      chunks,
      ...(gate ? { gate } : {}),
    });
  }
  release(gate: string): Promise<void> {
    return this.controller.call("releaseGate", {
      lease: this.lease.lease,
      gate,
    });
  }
  observe<T>(): Promise<T> {
    return this.controller.call("observe", { lease: this.lease.lease });
  }
}
export async function finishState(
  state: TestState,
  info: TestInfo,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await info.attach("native-stack", {
      body: JSON.stringify(await state.controller.evidence()),
      contentType: "application/json",
    });
    if (info.status !== info.expectedStatus) {
      for (const context of state.contexts) {
        for (const page of context.pages()) {
          await info.attach("page-before-reset", {
            body: await page.content(),
            contentType: "text/html",
          });
        }
      }
    }
  } catch (error) {
    errors.push(error);
  }
  for (const context of [...state.contexts].reverse()) {
    try {
      await context.close();
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await state.controller.call("endTest", { lease: state.lease.lease });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "Test evidence and cleanup failed");
  }
}
export const test = workerTest.extend<{ state: TestState }>({
  state: async ({ stack, context }, use, info) => {
    const identity = `${info.testId}-${info.retry}-${randomUUID()}`;
    const setup = performance.now();
    const lease = await stack.call<TestLease>("beginTest", { identity });
    const setupSeconds = (performance.now() - setup) / 1000;
    const start = performance.now();
    const state = new TestState(stack, lease, context);
    try {
      await use(state);
    } finally {
      const bodySeconds = (performance.now() - start) / 1000;
      const cleanup = performance.now();
      await finishState(state, info);
      console.info(
        JSON.stringify({
          test: identity,
          setupSeconds,
          bodySeconds,
          cleanupSeconds: (performance.now() - cleanup) / 1000,
        }),
      );
    }
  },
});
