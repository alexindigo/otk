// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { OpencodeV1Adapter } from "@otk/harness-opencode-v1";
import { OpencodeV2ServerAdapter } from "@otk/harness-opencode-v2-server";
import type { Harness } from "@otk/harness";
interface SocketEvent {
  method: string;
  params: Record<string, unknown>;
}

export interface CatalogWatchObservation {
  id: number;
  directory: string;
  acquired: number;
  subscriptions: number;
  releases: number;
  unsubscriptions: number;
  aborted: boolean;
  latePublications: number;
}

/** Observe the real adapter's watch, subscription and native lease release.
 * The synchronous watch acquisition is characterized in the adapter; no owner,
 * cache, response or cancellation behavior is substituted by this observer. */
export function observeCatalogWatches(backend: Harness) {
  assert(
    backend instanceof OpencodeV1Adapter ||
      backend instanceof OpencodeV2ServerAdapter,
  );
  const port = backend.capabilities.catalogs;
  assert(port);
  const records: CatalogWatchObservation[] = [];
  const catalogs = backend instanceof OpencodeV2ServerAdapter
    ? backend.catalogs?.catalogs
    : backend.catalogs;
  assert(catalogs);
  const originalWatch = port.watch, originalAcquire = catalogs.acquire;
  let entering: CatalogWatchObservation | undefined;
  catalogs.acquire = (directory) => {
    const lease = originalAcquire.call(catalogs, directory),
      observation = entering;
    if (!observation) return lease;
    assertEquals(directory, observation.directory);
    observation.acquired++;
    const release = lease.release, subscribe = lease.subscribe;
    lease.release = () => {
      release();
      observation.releases++;
    };
    lease.subscribe = (listener) => {
      observation.subscriptions++;
      const stop = subscribe(() => {
        if (observation.unsubscriptions) observation.latePublications++;
        listener();
      });
      return () => {
        stop();
        observation.unsubscriptions++;
      };
    };
    return lease;
  };
  port.watch = (directory, listener, signal) => {
    const observation: CatalogWatchObservation = {
      id: records.length + 1,
      directory,
      acquired: 0,
      subscriptions: 0,
      releases: 0,
      unsubscriptions: 0,
      aborted: signal.aborted,
      latePublications: 0,
    };
    records.push(observation);
    entering = observation;
    try {
      const result = originalWatch.call(port, directory, listener, signal);
      signal.addEventListener("abort", () => {
        observation.aborted = true;
      }, { once: true });
      observation.aborted = signal.aborted;
      return result;
    } finally {
      entering = undefined;
    }
  };
  return {
    records,
    restore() {
      port.watch = originalWatch;
      catalogs.acquire = originalAcquire;
    },
  };
}

interface Generation {
  socket: string;
  hellos: number;
  welcomes: number;
  requests: { method: string; directory: unknown }[];
}
const discovery =
  /^(?:catalogs\.|agents\.list|models\.list|commands\.list|resources\.list|find\.files|frecency\.list)/;

/** CDP socket identities distinguish accepted generations from failed handshakes. */
export function catalogGenerations(
  events: readonly SocketEvent[],
): Generation[] {
  const generations = new Map<string, Generation>();
  for (const event of events) {
    if (!/^Network\.webSocketFrame(?:Sent|Received)$/.test(event.method)) {
      continue;
    }
    const response = event.params.response as {
      opcode: number;
      payloadData: string;
    };
    if (response.opcode !== 1) continue;
    const socket = String(event.params.requestId);
    assert(
      socket && socket !== "undefined",
      "The observation must identify a real socket",
    );
    let generation = generations.get(socket);
    if (!generation) {
      generation = { socket, hellos: 0, welcomes: 0, requests: [] };
      generations.set(socket, generation);
    }
    const frame = JSON.parse(response.payloadData);
    if (event.method.endsWith("Sent") && frame.t === "hello") {
      generation.hellos++;
    }
    if (event.method.endsWith("Received") && frame.t === "welcome") {
      generation.welcomes++;
    }
    if (
      event.method.endsWith("Sent") && frame.t === "request" &&
      discovery.test(frame.method)
    ) {
      generation.requests.push({
        method: frame.method,
        directory: frame.params?.directory,
      });
    }
  }
  return [...generations.values()].filter((generation) =>
    generation.hellos || generation.welcomes || generation.requests.length
  );
}

/** Readiness predicate only; the assertion below rejects duplicates and leaks. */
export function generationDemandReady(
  events: readonly SocketEvent[],
) {
  const accepted = catalogGenerations(events).filter((generation) =>
    generation.welcomes
  );
  return accepted.length > 0 &&
    accepted.every((generation) =>
      generation.requests.some((request) =>
        request.method === "catalogs.watch"
      ) &&
      generation.requests.some((request) => request.method === "frecency.list")
    );
}

export function assertCatalogGenerations(
  events: readonly SocketEvent[],
  watches: readonly CatalogWatchObservation[],
  directory: string,
  closed = false,
) {
  const generations = catalogGenerations(events);
  const accepted = generations.filter((generation) => generation.welcomes);
  assert(accepted.length > 0);
  for (const generation of generations) {
    assertEquals(generation.hellos, 1);
    assertEquals(generation.welcomes, generation.requests.length ? 1 : 0);
    if (!generation.welcomes) {
      assertEquals(generation.requests, []);
      continue;
    }
    assertEquals(generation.requests.map((request) => request.method).sort(), [
      "catalogs.watch",
      "frecency.list",
    ]);
    assert(
      generation.requests.every((request) => request.directory === directory),
    );
  }
  assert(
    watches.length >= accepted.length,
    "Every generation must reach the real native watch owner",
  );
  for (const watch of watches) {
    assertEquals(watch.directory, directory);
    assertEquals(watch.acquired, 1);
    assertEquals(watch.subscriptions, 1);
    assertEquals(watch.latePublications, 0);
  }
  const retired = closed ? watches : watches.slice(0, -1);
  for (const watch of retired) {
    assertEquals(
      watch.releases,
      1,
      `Watch ${watch.id}: native lease was not released`,
    );
    assertEquals(
      watch.unsubscriptions,
      1,
      `Watch ${watch.id}: listener was not detached`,
    );
    assertEquals(watch.aborted, true);
  }
  if (!closed) {
    assertEquals(watches.at(-1)?.releases, 0);
    assertEquals(watches.at(-1)?.unsubscriptions, 0);
    assertEquals(watches.at(-1)?.aborted, false);
  }
  return accepted;
}
