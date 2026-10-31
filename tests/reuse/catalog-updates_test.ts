// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createDirectoryCatalogs } from "@otk/client";
import { arrayCatalogCodec, createCatalogCodecs } from "@otk/protocol";
import type { DirectoryCatalog } from "@otk/protocol";

declare module "@otk/protocol" {
  interface DirectoryCatalogKinds {
    "example.choices": { id: string; title: string }[];
  }
  interface CatalogChunkKinds {
    "example.choices": { id: string; title: string };
  }
}

Deno.test("an independent feature contributes catalog values and chunks without changing transport machinery", async () => {
  const initial: DirectoryCatalog = {
    directory: "/external",
    generation: "g",
    revision: 0,
    paths: { style: "posix", separator: "/" },
    values: { "example.choices": { state: "digesting", revision: 0 } },
  };
  const codec = arrayCatalogCodec<"example.choices">();
  let released = 0;
  const owner = createDirectoryCatalogs({
    codecs: { ...createCatalogCodecs(), "example.choices": codec },
    watch: () => ({
      result: Promise.resolve(initial),
      release() {
        released++;
      },
    }),
    refresh: () => Promise.resolve(),
  });
  const lease = owner.acquire("/external");
  await lease.ready();
  const values = Array.from(
    { length: 5 },
    (_, i) => ({ id: String(i), title: `Choice ${i}` }),
  );
  const chunks = [...codec.chunks(values, 2)];
  for (const [part, items] of chunks.entries()) {
    owner.receive({
      t: "catalog.chunk",
      directory: "/external",
      generation: "g",
      revision: 1,
      transfer: "external",
      kind: "example.choices",
      part,
      last: part === chunks.length - 1,
      items,
    });
  }
  assertEquals(chunks.map((items) => items.length), [2, 2, 1]);
  assertEquals(lease.view("example.choices").state.value, values);
  lease.release();
  assertEquals(released, 1);
  assertEquals(lease.state.catalog, undefined);
  owner.stop();
});
