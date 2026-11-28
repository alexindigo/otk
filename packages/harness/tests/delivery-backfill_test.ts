// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { DeliveryBackfill } from "../delivery-backfill.ts";
import type {
  DeliveryPage,
  ProviderReadKinds,
  ProviderReadPort,
} from "../provider-reads.ts";

Deno.test("historical delivery chunks yield to interactive work, coalesce parent demand and join cancellation", async () => {
  let reads = 0,
    interactive = 0,
    published = 0,
    release = 0,
    finished: () => void = () => {};
  const done = new Promise<void>((resolve) => finished = resolve);
  const port: ProviderReadPort = {
    read<K extends keyof ProviderReadKinds>(
      kind: K,
      _input: ProviderReadKinds[K]["input"],
      options: Parameters<ProviderReadPort["read"]>[2],
    ) {
      assertEquals(kind, "supervision.deliveries");
      assertEquals(options.priority, "background");
      assert(!options.signal?.aborted);
      reads++;
      const updates = Array.from(
        { length: 16 },
        (_, i) => ({
          id: `tstv1-helper${(reads - 1) * 16 + i}`,
          delivered: {
            parentID: "tstv1-parent",
            receipt: `receipt${reads}-${i}`,
            terminal: 100,
          },
        }),
      );
      const page: DeliveryPage = {
        updates,
        ...(reads < 8 ? { after: String(reads) } : {}),
      };
      return Promise.resolve(page as ProviderReadKinds[K]["result"]);
    },
    release() {
      release++;
    },
  };
  const owner = new DeliveryBackfill(port, (_parent, updates) => {
    published += updates.length;
    if (published === 128) finished();
    // Interactive work must run before the next bounded publication.
    queueMicrotask(() => interactive++);
  }, (error) => {
    throw error;
  });
  owner.request("tstv1-parent");
  await done;
  assertEquals(reads, 8);
  assertEquals(published, 128);
  assert(interactive >= 7);
  await owner.stop();
  assertEquals(release, 1);
  owner.request("tstv1-parent");
  assertEquals(reads, 8);
});
