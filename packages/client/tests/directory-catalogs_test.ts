// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createDirectoryCatalogs } from "../directory-catalogs.ts";
import { createCatalogCodecs } from "@otk/protocol";
import type { CatalogChunk, DirectoryCatalog } from "@otk/protocol";
Deno.test("directory demand shares watch and publishes only complete contiguous chunks", async () => {
  let watches = 0, releases = 0;
  const initial: DirectoryCatalog = {
    directory: "/p",
    generation: "g",
    revision: 0,
    paths: { style: "posix", separator: "/" },
    values: { files: { state: "digesting", revision: 0 } },
  };
  const owner = createDirectoryCatalogs({
    watch: () => {
      watches++;
      return {
        result: Promise.resolve(initial),
        release: () => {
          releases++;
        },
      };
    },
    refresh: () => Promise.resolve(),
    demand: () => Promise.resolve(),
    codecs: createCatalogCodecs(),
  });
  const a = owner.acquire("/p"), b = owner.acquire("/p");
  await a.ready();
  assertEquals(watches, 1);
  owner.receive({
    t: "catalog.chunk",
    directory: "/p",
    generation: "g",
    revision: 1,
    transfer: "x",
    part: 0,
    last: false,
    kind: "files",
    items: [{ path: "one", canonicalPath: "/p/one", directory: false }],
  });
  assertEquals(a.state.catalog?.values.files?.value, undefined);
  owner.receive({
    t: "catalog.chunk",
    directory: "/p",
    generation: "g",
    revision: 1,
    transfer: "x",
    part: 1,
    last: true,
    kind: "files",
    items: [{ path: "two", canonicalPath: "/p/two", directory: false }],
  });
  assertEquals(b.state.catalog?.values.files?.value?.length, 2);
  a.release();
  assertEquals(releases, 0);
  b.release();
  assertEquals(releases, 1);
  const c = owner.acquire("/p");
  await c.ready();
  assertEquals(c.state.catalog?.values.files?.value, undefined);
  assertEquals(watches, 2);
  c.release();
  owner.stop();
});

for (const kind of ["commands", "agents", "files", "models"] as const) {
  Deno.test(`directory ${kind} readiness waits for its complete value, not a ready header`, async () => {
    const initial: DirectoryCatalog = {
      directory: "/p",
      generation: "g",
      revision: 1,
      paths: { style: "posix", separator: "/" },
      values: {
        skills: { state: "ready", revision: 1, value: [] },
        [kind]: { state: "ready", revision: 1 },
      },
    };
    const owner = createDirectoryCatalogs({
      watch: () => ({ result: Promise.resolve(initial), release() {} }),
      refresh: () => Promise.resolve(),
      demand: () => Promise.resolve(),
      codecs: createCatalogCodecs(),
    });
    const lease = owner.acquire("/p");
    try {
      await lease.ready();
      await lease.ready("skills"); // Unrelated complete choices never wait.
      assertEquals(lease.view(kind).state.loading, true);
      let ready = false;
      const pending = lease.ready(kind).then(() => ready = true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(ready, false);
      // Repeated headers cannot certify a transfer which has not arrived.
      owner.receive({ t: "catalog.snapshot", catalog: initial });
      owner.receive({
        t: "catalog.chunk",
        directory: "/p",
        generation: "g",
        revision: 1,
        transfer: "pending",
        part: 0,
        last: false,
        kind,
        items: kind === "models"
          ? [{ kind: "catalog", defaultState: "unknown" }]
          : [],
      } as CatalogChunk);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(ready, false);
      owner.receive({
        t: "catalog.chunk",
        directory: "/p",
        generation: "g",
        revision: 1,
        transfer: "pending",
        part: 1,
        last: true,
        kind,
        items: [],
      } as CatalogChunk);
      await pending;
      assertEquals(ready, true);
      assertEquals(lease.view(kind).state.loading, false);
      owner.receive({ t: "catalog.snapshot", catalog: initial });
      assertEquals(lease.view(kind).state.loading, false);
    } finally {
      lease.release();
      owner.stop();
    }
  });
}

Deno.test("replacement catalog headers retain last-good choices without certifying the new value", async () => {
  const initial: DirectoryCatalog = {
    directory: "/p",
    generation: "g",
    revision: 1,
    paths: { style: "posix", separator: "/" },
    values: { files: { state: "ready", revision: 1, value: [] } },
  };
  const owner = createDirectoryCatalogs({
    watch: () => ({ result: Promise.resolve(initial), release() {} }),
    refresh: () => Promise.resolve(),
    demand: () => Promise.resolve(),
    codecs: createCatalogCodecs(),
  });
  const lease = owner.acquire("/p");
  try {
    await lease.ready("files");
    for (const generation of ["g", "replacement"]) {
      owner.receive({
        t: "catalog.snapshot",
        catalog: {
          ...initial,
          generation,
          revision: 2,
          values: { files: { state: "ready", revision: 2 } },
        },
      });
      assertEquals(lease.view("files").state.value, []);
      assertEquals(lease.view("files").state.loading, true);
    }
    let settled = false;
    const pending = lease.ready("files").then(() => settled = true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(settled, false);
    lease.release();
    await pending;
    assertEquals(settled, true, "Release retires only the borrower's wait");
  } finally {
    lease.release();
    owner.stop();
  }
});

Deno.test("unrelated catalog metadata cannot invalidate a kind's chunk transfer", async () => {
  const owner = createDirectoryCatalogs({
    watch: () => ({
      result: Promise.resolve({
        directory: "/p",
        generation: "g",
        revision: 0,
        paths: { style: "posix" as const, separator: "/" as const },
        values: { files: { state: "digesting" as const, revision: 0 } },
      }),
      release() {},
    }),
    refresh: () => Promise.resolve(),
    demand: () => Promise.resolve(),
    codecs: createCatalogCodecs(),
  });
  const lease = owner.acquire("/p");
  await lease.ready();
  owner.receive({
    t: "catalog.chunk",
    directory: "/p",
    generation: "g",
    revision: 1,
    transfer: "a",
    part: 0,
    last: false,
    kind: "files",
    items: [{ path: "one", canonicalPath: "/p/one", directory: false }],
  });
  owner.receive({
    t: "catalog.snapshot",
    catalog: {
      directory: "/p",
      generation: "g",
      revision: 2,
      paths: { style: "posix", separator: "/" },
      values: {
        files: { state: "digesting", revision: 0 },
        agents: { state: "digesting", revision: 2 },
      },
    },
  });
  owner.receive({
    t: "catalog.chunk",
    directory: "/p",
    generation: "g",
    revision: 1,
    transfer: "a",
    part: 1,
    last: true,
    kind: "files",
    items: [],
  });
  assertEquals(lease.state.catalog?.values.files?.value?.length, 1);
  lease.release();
  owner.stop();
});
