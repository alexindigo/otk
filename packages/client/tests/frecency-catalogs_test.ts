// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createFrecencyCatalogs } from "../frecency-catalogs.ts";
import type { InboxRpc } from "../inbox.ts";
Deno.test("frecency borrowers share one baseline, reduce keyed ranks and retire held generations", async () => {
  let reads = 0, aborted = 0;
  const owner = createFrecencyCatalogs(
    {
      call: (
        _method: string,
        params: { directory: string },
        signal: AbortSignal,
      ) => {
        reads++;
        signal.addEventListener("abort", () => {
          aborted++;
        }, { once: true });
        return Promise.resolve({
          directory: params.directory,
          revision: 0,
          entries: [{ path: "/p/one", score: 1, last: 1 }],
        });
      },
    } as unknown as InboxRpc,
  );
  const a = owner.acquire("/p"), b = owner.acquire("/p");
  await a.ready();
  await b.ready();
  assertEquals(reads, 1);
  owner.receive({
    t: "frecency.patch",
    directory: "/p",
    revision: 1,
    upsert: [{ path: "/p/two", score: 2, last: 2 }],
    remove: ["/p/one"],
  });
  assertEquals(b.entries, [{ path: "/p/two", score: 2, last: 2 }]);
  assertEquals(b.scores.get("/p/two")?.score, 2);
  a.release();
  assertEquals(aborted, 0);
  b.release();
  assertEquals(aborted, 1);
  owner.stop();
});
