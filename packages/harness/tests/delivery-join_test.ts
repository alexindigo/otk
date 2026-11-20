// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { DeliveredEvidence } from "@otk/protocol";
import { DeliveryJoin } from "../delivery-join.ts";
import type { ProviderReadKinds, ProviderReadPort } from "../provider-reads.ts";

Deno.test("delivery join reads only durable facts, reports absence, and lets a newer request win", async () => {
  const store = new Map<string, DeliveredEvidence>([
    ["tstv1-a", { parentID: "tstv1-p", receipt: "r1", terminal: 10 }],
  ]);
  const reads: string[][] = [];
  const gate: { current?: PromiseWithResolvers<void> } = {};
  let release = 0;
  const port: ProviderReadPort = {
    async read<K extends keyof ProviderReadKinds>(
      kind: K,
      input: ProviderReadKinds[K]["input"],
      options: Parameters<ProviderReadPort["read"]>[2],
    ) {
      assertEquals(kind, "supervision.delivered");
      assertEquals(options.priority, "attention");
      const ids = (input as { ids: string[] }).ids;
      reads.push(ids);
      // The answer reflects the store when the read ran, not when it returns.
      const facts = ids.flatMap((id) => {
        const delivered = store.get(id);
        return delivered ? [{ id, delivered }] : [];
      });
      await gate.current?.promise;
      return facts as ProviderReadKinds[K]["result"];
    },
    release() {
      release++;
    },
  };
  const applied: [string, DeliveredEvidence | undefined][] = [];
  const join = new DeliveryJoin(
    port,
    (id, fact) => applied.push([id, fact]),
    (error) => {
      throw error;
    },
    2,
  );
  join.request(["tstv1-a", "tstv1-b", "tstv1-a"]);
  await join.settle();
  assertEquals(reads, [["tstv1-a", "tstv1-b"]]);
  assertEquals(applied, [
    ["tstv1-a", store.get("tstv1-a")],
    ["tstv1-b", undefined],
  ]);
  // A request arriving during a read supersedes that read's older answer.
  applied.length = 0;
  reads.length = 0;
  gate.current = Promise.withResolvers<void>();
  join.request(["tstv1-a"]);
  await Promise.resolve();
  await Promise.resolve();
  store.set("tstv1-a", { parentID: "tstv1-p", receipt: "r2", terminal: 20 });
  join.request(["tstv1-a"]);
  gate.current.resolve();
  await join.settle();
  assertEquals(reads, [["tstv1-a"], ["tstv1-a"]]);
  assertEquals(applied, [["tstv1-a", store.get("tstv1-a")]]);
  await join.stop();
  assertEquals(release, 1);
  join.request(["tstv1-a"]);
  await join.settle();
  assertEquals(reads.length, 2);
});
