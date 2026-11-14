// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createDirectoryCatalogs } from "@otk/client";
import { DirectoryCatalogs, type ProviderReadKinds } from "@otk/harness";
import { createCatalogCodecs, type DirectoryCatalog } from "@otk/protocol";

const initial = (): DirectoryCatalog => ({
  directory: "/p",
  generation: "g",
  revision: 0,
  paths: { style: "posix", separator: "/" },
  values: { agents: { state: "digesting", revision: 0 } },
});
const turns = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};

for (const synchronous of [false, true]) {
  Deno.test(`catalog lifetime retries an unpublished demand failure (synchronous: ${synchronous})`, async () => {
    let calls = 0;
    const owner = createDirectoryCatalogs({
      codecs: createCatalogCodecs(),
      watch: () => ({ result: Promise.resolve(initial()), release() {} }),
      refresh: () => Promise.resolve(),
      demand: () => {
        if (++calls === 1) {
          if (synchronous) throw new Error("unpublished demand failure");
          return Promise.reject(new Error("unpublished demand failure"));
        }
        owner.receive({
          t: "catalog.snapshot",
          catalog: {
            ...initial(),
            revision: 1,
            values: { agents: { state: "ready", revision: 1, value: [] } },
          },
        });
        return Promise.resolve();
      },
    });
    const lease = owner.acquire("/p");
    let retried: Promise<void> | undefined;
    try {
      await lease.ready();
      await assertRejects(
        () => lease.ready("agents"),
        Error,
        "unpublished demand failure",
      );
      retried = lease.ready("agents");
      await turns();
      assertEquals(
        calls,
        2,
        "the failed reservation cannot suppress a new consumer intent",
      );
      await retried;
      assertEquals(lease.view("agents").state.value, []);
    } finally {
      lease.release();
      owner.stop();
      await retried;
    }
  });
}

for (const phase of ["watch", "demand"] as const) {
  for (const ending of ["release", "stop"] as const) {
    Deno.test(`catalog lifetime ${ending} wakes readiness during ${phase} without retiring another borrower`, async () => {
      const watch = Promise.withResolvers<DirectoryCatalog>();
      const native = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined, demands = 0;
      const owner = createDirectoryCatalogs({
        codecs: createCatalogCodecs(),
        watch: () => ({
          result: phase === "watch"
            ? watch.promise
            : Promise.resolve(initial()),
          release() {},
        }),
        refresh: () => Promise.resolve(),
        demand: (_directory, _kinds, _intent, active) => {
          demands++;
          signal = active;
          entered.resolve();
          return native.promise;
        },
      });
      const a = owner.acquire("/p"), b = owner.acquire("/p");
      let aReady = false, bReady = false;
      const aWork = a.ready("agents").then(() => {
        aReady = true;
      });
      const bWork = b.ready(phase === "watch" ? undefined : "agents").then(
        () => {
          bReady = true;
        },
      );
      try {
        if (phase === "demand") await entered.promise;
        await turns();
        if (ending === "release") a.release();
        else owner.stop();
        await turns();
        assertEquals(aReady, true, "retirement must not wait for shared I/O");
        assertEquals(bReady, ending === "stop");
        assertEquals(demands, phase === "demand" ? 1 : 0);
        if (phase === "demand") {
          assertEquals(signal?.aborted, ending === "stop");
        }
        if (ending === "release") {
          owner.receive({
            t: "catalog.snapshot",
            catalog: {
              ...initial(),
              revision: 1,
              values: { agents: { state: "ready", revision: 1, value: [] } },
            },
          });
          watch.resolve(initial());
          native.resolve();
          await bWork;
          assertEquals(bReady, true);
          assertEquals(
            demands,
            phase === "demand" ? 1 : 0,
            "a retired waiter cannot initiate a new demand after its watch resolves",
          );
        }
      } finally {
        a.release();
        b.release();
        owner.stop();
        watch.resolve(initial());
        native.resolve();
        await Promise.all([aWork, bWork]);
      }
    });
  }
}

Deno.test("catalog lifetime renews released file demand before a selected refresh", async () => {
  let files = 0;
  const owner = new DirectoryCatalogs({
    read<K extends keyof ProviderReadKinds>(
      kind: K,
    ): Promise<ProviderReadKinds[K]["result"]> {
      if (kind === "catalog.files") files++;
      return Promise.resolve(
        (kind === "catalog.files"
          ? { physical: "/p", items: [] }
          : []) as unknown as ProviderReadKinds[K]["result"],
      );
    },
    release() {},
  }, { pending: 100 });
  const retained = owner.acquire("/p"), first = owner.acquire("/p");
  try {
    await retained.get("agents");
    await first.get("files");
    first.release();
    assertEquals(retained.snapshot().values.files?.value, undefined);
    await retained.refresh(undefined, ["files"]);
    assertEquals(files, 2);
    assertEquals(retained.snapshot().values.files?.state, "ready");
    await retained.get("files");
    assertEquals(files, 2, "refresh and get borrow one renewed file lifetime");
  } finally {
    first.release();
    retained.release();
    await owner.stop();
  }
});
