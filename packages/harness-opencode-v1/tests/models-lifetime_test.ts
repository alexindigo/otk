// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { cfg } from "../../../tests/support/config.ts";
import { Client } from "../client.ts";
import type { Directory } from "../directory.ts";
import { models } from "../models.ts";
import { agents } from "../agents.ts";

Deno.test("retiring a catalog read aborts both native provider/config lifetimes", async () => {
  const gates: PromiseWithResolvers<Response>[] = [],
    signals: AbortSignal[] = [];
  const fetcher: typeof fetch = (_input, options) => {
    const result = Promise.withResolvers<Response>();
    gates.push(result);
    signals.push(options!.signal!);
    options!.signal!.addEventListener(
      "abort",
      () => result.reject(options!.signal!.reason),
      { once: true },
    );
    return result.promise;
  };
  const catalog = models(
    new Client(cfg().harness, fetcher),
    { resolve: () => Promise.resolve("/p") } as unknown as Directory,
  );
  const retired = new AbortController();
  const pending = Reflect.apply(catalog.listModels, catalog, [
    "opcv1-s",
    retired.signal,
  ]) as Promise<unknown>;
  const settled = pending.catch(() => undefined);
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assertEquals(signals.length, 2);
    retired.abort(new DOMException("Catalog retired", "AbortError"));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert(signals.every((signal) => signal.aborted));
  } finally {
    for (const gate of gates) {
      gate.reject(new DOMException("Fixture closing", "AbortError"));
    }
    await settled;
  }
});

Deno.test("retiring an agent catalog read aborts its native inventory lifetime", async () => {
  const response = Promise.withResolvers<Response>();
  let received: AbortSignal | undefined;
  const fetcher: typeof fetch = (_input, options) => {
    received = options?.signal ?? undefined;
    received?.addEventListener(
      "abort",
      () => response.reject(received!.reason),
      { once: true },
    );
    return response.promise;
  };
  const catalog = agents(
    new Client(cfg().harness, fetcher),
    { resolve: () => Promise.resolve("/p") } as unknown as Directory,
  );
  const retired = new AbortController();
  const pending = Reflect.apply(catalog.listAgents, catalog, [
    "opcv1-s",
    true,
    retired.signal,
  ]) as Promise<unknown>;
  const settled = pending.catch(() => undefined);
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert(received);
    retired.abort(new DOMException("Agent catalog retired", "AbortError"));
    assert(received.aborted);
  } finally {
    response.reject(new DOMException("Fixture closing", "AbortError"));
    await settled;
  }
});
