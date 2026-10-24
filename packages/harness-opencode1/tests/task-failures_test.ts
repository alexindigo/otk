// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { TaskProgress } from "../tasks.ts";
import type { Info, RawPart } from "../types.ts";

const fixture = async () => {
  const data = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../../../tests/fixtures/opencode1/m3-tasks.json",
        import.meta.url,
      ),
    ),
  ) as {
    parent: { info: Info; parts: RawPart[] }[];
    child: { info: Info; parts: RawPart[] }[];
  };
  const raw = data.parent.flatMap((m) => m.parts).find((p) =>
    p.tool === "task"
  )!;
  return { ...data, raw };
};

Deno.test("task refresh failures belong to each live parent and do not skip healthy siblings", async () => {
  const data = await fixture(),
    failed = Promise.withResolvers<void>(),
    delivered = Promise.withResolvers<void>();
  const parents: string[] = [], emissions: string[] = [];
  const healthy = {
    ...data.raw,
    id: data.raw.id + "-healthy",
    sessionID: "healthy",
  };
  const tracker = new TaskProgress(
    (id, message) => {
      if (!message) return Promise.resolve(data.child);
      if (id === data.raw.sessionID) {
        return Promise.reject(new Error("missing parent"));
      }
      return Promise.resolve([{ info: data.parent[0].info, parts: [healthy] }]);
    },
    () => true,
    (parent) => {
      emissions.push(parent);
      delivered.resolve();
    },
    (parent) => {
      parents.push(parent);
      failed.resolve();
    },
  );
  try {
    await tracker.shape(data.raw);
    await tracker.shape(healthy);
    tracker.observe(data.child[0].info.sessionID);
    await failed.promise;
    // A queue boundary, not an elapsed-time guess: a healthy link acknowledges refresh.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        delivered.promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("healthy sibling skipped")),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assertEquals(parents, [data.raw.sessionID]);
    assertEquals(emissions, ["healthy"]);
  } finally {
    tracker.release();
  }
});

Deno.test("a retired task parent cannot report a late refresh failure into its replacement", async () => {
  const data = await fixture(),
    entered = Promise.withResolvers<void>(),
    late = Promise.withResolvers<never>();
  const failures: string[] = [];
  const tracker = new TaskProgress(
    (_id, message) => {
      if (!message) return Promise.resolve(data.child);
      entered.resolve();
      return late.promise;
    },
    () => true,
    () => {},
    (parent) => failures.push(parent),
  );
  try {
    await tracker.shape(data.raw);
    tracker.observe(data.child[0].info.sessionID);
    await entered.promise;
    tracker.release(data.raw.sessionID);
    await tracker.shape(data.raw);
    late.reject(new Error("retired"));
    await late.promise.catch(() => {});
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assertEquals(failures, []);
  } finally {
    tracker.release();
  }
});
