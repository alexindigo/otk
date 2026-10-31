// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import { createDirectoryCatalogs } from "@otk/client";
import { createCatalogCodecs, type DirectoryCatalog } from "@otk/protocol";

Deno.test("plain consumer shares 251 session borrows and retires one hundred partial directory lifetimes", async () => {
  let watches = 0, releases = 0, refreshes = 0;
  const pending: ReturnType<typeof Promise.withResolvers<DirectoryCatalog>>[] =
    [];
  const owner = createDirectoryCatalogs({
    codecs: createCatalogCodecs(),
    watch: () => {
      watches++;
      const result = Promise.withResolvers<DirectoryCatalog>();
      pending.push(result);
      return {
        result: result.promise,
        release() {
          releases++;
        },
      };
    },
    refresh: () => {
      refreshes++;
      return Promise.resolve();
    },
  });
  const initial: DirectoryCatalog = {
    directory: "/same",
    generation: "initial",
    revision: 0,
    paths: { style: "posix", separator: "/" },
    values: { files: { state: "digesting", revision: 0 } },
  };
  const anchor = owner.acquire("/same");
  pending[0].resolve(initial);
  await anchor.ready();
  const leases = Array.from({ length: 251 }, () => owner.acquire("/same"));
  for (const lease of leases) {
    await lease.ready();
    assertStrictEquals(lease.state.catalog, anchor.state.catalog);
    lease.release();
  }
  assertEquals(watches, 1);
  assertEquals(releases, 0);
  anchor.release();
  for (let n = 0; n < 100; n++) {
    const lease = owner.acquire("/same");
    pending.at(-1)!.resolve({ ...initial, generation: `g-${n}` });
    await lease.ready();
    owner.receive({
      t: "catalog.chunk",
      directory: "/same",
      generation: `g-${n}`,
      revision: 1,
      transfer: `partial-${n}`,
      part: 0,
      last: false,
      kind: "files",
      items: [{
        path: `private-${n}`,
        canonicalPath: `/same/private-${n}`,
        directory: false,
      }],
    });
    lease.release();
    owner.receive({
      t: "catalog.chunk",
      directory: "/same",
      generation: `g-${n}`,
      revision: 1,
      transfer: `partial-${n}`,
      part: 1,
      last: true,
      kind: "files",
      items: [],
    });
    assertEquals(
      lease.state.catalog,
      undefined,
      "Late completion cannot restore a retired body",
    );
  }
  assertEquals(watches, 101);
  assertEquals(releases, 101);
  assertEquals(refreshes, 0);
  owner.stop();
});
