// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type IndexEntry,
  knownDerived,
  type TranscriptVersion,
  type TurnUsageDetail,
  UsageLedger,
} from "@otk/protocol";
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import type { SidecarConnection } from "../connection.ts";
import { createSessionUsage } from "../session-usage.ts";
import { shellEntry } from "./shell-fixture.ts";

const target = { sidecarId: "server", sessionID: "s", turnID: "turn" };
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function detail(version: TranscriptVersion, input = 7): TurnUsageDetail {
  return {
    ...new UsageLedger("s", [{
      id: "step",
      turnID: "turn",
      model: { provider: "test", model: "scripted" },
      tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      completed: true,
    }]).detail("turn"),
    version,
    clock: { epoch: "usage", seq: 0 },
  };
}
function fixture(entry?: IndexEntry) {
  const reads: {
    result: PromiseWithResolvers<TurnUsageDetail>;
    signal: AbortSignal;
  }[] = [];
  const connection = {
    supports: () => true,
    messages: fixtureMessagePolicy,
    rpc: {
      call(_method: string, _params: unknown, signal: AbortSignal) {
        const result = Promise.withResolvers<TurnUsageDetail>();
        signal.addEventListener("abort", () => result.reject(signal.reason), {
          once: true,
        });
        reads.push({ result, signal });
        return result.promise;
      },
    },
  } as unknown as SidecarConnection;
  const owner = createSessionUsage(
    () => connection,
    undefined,
    entry ? () => entry : undefined,
  );
  const release = owner.retain(target);
  return {
    owner,
    reads,
    stop() {
      release();
      owner.stop();
    },
  };
}

Deno.test("open usage detail ignores bootstrap and already-covered or unrelated invalidation versions", async () => {
  const f = fixture(), version = { generation: 2, revision: 3 };
  try {
    const pending = f.owner.load(target);
    await flush();
    f.reads[0].result.resolve(detail(version));
    await pending;
    const current = f.owner.get(target);
    f.owner.receive("server", { t: "bootstrap.complete" });
    for (
      const invalidation of [
        { version },
        { version: { generation: 1, revision: 999 } },
        { version: { generation: 2, revision: 2 }, sessionID: "s" },
        { version: { generation: 3, revision: 0 }, sessionID: "other" },
      ]
    ) {
      f.owner.receive("server", {
        t: "transcript.invalidated",
        ...invalidation,
      });
    }
    await flush();
    assertEquals(f.reads.length, 1);
    assertStrictEquals(f.owner.get(target), current);
    assertEquals(current?.summary.tokens.input, 7);
  } finally {
    f.stop();
  }
});

for (const covered of [false, true]) {
  Deno.test(`held usage detail ${covered ? "covering" : "older than"} invalidation cannot cause duplicate or stale publication`, async () => {
    const f = fixture(), seen: (number | null | undefined)[] = [];
    const unsubscribe = f.owner.subscribe(() =>
      seen.push(f.owner.get(target)?.summary.tokens.input)
    );
    try {
      const pending = f.owner.load(target);
      await flush();
      const frame = {
        t: "transcript.invalidated" as const,
        sessionID: "s",
        version: { generation: 3, revision: 0 },
      };
      f.owner.receive("server", frame);
      f.owner.receive("server", frame);
      f.reads[0].result.resolve(
        detail({ generation: covered ? 3 : 2, revision: 0 }, covered ? 7 : 1),
      );
      await pending;
      await flush();
      if (!covered) {
        assertEquals(f.owner.get(target), undefined);
        assertEquals(f.reads.length, 2);
        f.reads[1].result.resolve(detail(frame.version));
        await f.owner.load(target);
      }
      await flush();
      assertEquals(f.reads.length, covered ? 1 : 2);
      assertEquals(f.owner.get(target)?.summary.tokens.input, 7);
      assertEquals(seen.includes(1), false);
      f.owner.receive("server", frame);
      await flush();
      assertEquals(f.reads.length, covered ? 1 : 2);
    } finally {
      unsubscribe();
      f.stop();
    }
  });
}

Deno.test("persistent stale usage authority retries once immediately then backs off and releases its lease", async () => {
  const f = fixture();
  try {
    const pending = f.owner.load(target);
    await flush();
    f.owner.receive("server", {
      t: "transcript.invalidated",
      version: { generation: 4, revision: 0 },
    });
    f.reads[0].result.resolve(detail({ generation: 3, revision: 0 }, 1));
    await pending;
    await flush();
    assertEquals(f.reads.length, 2);
    f.reads[1].result.resolve(detail({ generation: 3, revision: 0 }, 1));
    await f.owner.load(target);
    await flush();
    assertEquals(f.reads.length, 2);
    assertEquals(f.owner.get(target), undefined);
    assert(f.owner.error(target));
  } finally {
    f.stop();
  }
});

Deno.test("covered refresh demands join one held usage request", async () => {
  const f = fixture(), version = { generation: 2, revision: 3 };
  try {
    const pending = f.owner.load(target);
    await flush();
    assertStrictEquals(f.owner.load(target, true), pending);
    assertStrictEquals(f.owner.load(target, true), pending);
    assertEquals(f.reads.length, 1);
    f.reads[0].result.resolve(detail(version));
    await pending;
    await flush();
    assertEquals(f.reads.length, 1);
    assertEquals(f.owner.get(target)?.summary.tokens.input, 7);
  } finally {
    f.stop();
  }
});
Deno.test("held usage demand A to B to A retires the obsolete successor", async () => {
  const entry = shellEntry("s"),
    version = { generation: 2, revision: 3 },
    value = detail(version);
  entry.digest.turns.turn = knownDerived(value.summary, "A", 1);
  const f = fixture(entry);
  try {
    const pending = f.owner.load(target);
    await flush();
    entry.digest.turns.turn = knownDerived(value.summary, "B", 1);
    f.owner.receive("server", { t: "index.patch", rev: 1, ops: [] });
    entry.digest.turns.turn = knownDerived(value.summary, "A", 1);
    f.owner.receive("server", { t: "index.patch", rev: 2, ops: [] });
    f.reads[0].result.resolve(value);
    await pending;
    await flush();
    assertEquals(
      f.reads.length,
      1,
      "Only the latest uncovered demand may schedule a successor",
    );
    assertEquals(f.owner.get(target)?.summary.tokens.input, 7);
  } finally {
    f.stop();
  }
});

for (const change of ["revision", "source"] as const) {
  Deno.test(`a newer usage ${change} during a held request schedules exactly one follow-up`, async () => {
    const entry = shellEntry("s"), version = { generation: 2, revision: 3 };
    const value = detail(version);
    entry.digest.turns.turn = knownDerived(value.summary, "source", 1);
    const f = fixture(entry);
    try {
      const pending = f.owner.load(target);
      await flush();
      entry.digest.turns.turn = knownDerived(
        value.summary,
        change === "source" ? "replacement" : "source",
        change === "revision" ? 2 : 1,
      );
      for (let rev = 1; rev <= 2; rev++) {
        f.owner.receive("server", { t: "index.patch", rev, ops: [] });
        assertStrictEquals(f.owner.load(target, true), pending);
      }
      assertEquals(f.reads.length, 1);
      f.reads[0].result.resolve(value);
      await pending;
      await flush();
      assertEquals(f.reads.length, 2);
      const successor = f.owner.load(target);
      assertStrictEquals(f.owner.load(target, true), successor);
      f.reads[1].result.resolve(value);
      await successor;
      await flush();
      assertEquals(f.reads.length, 2);
      assertEquals(f.owner.get(target)?.summary.tokens.input, 7);
    } finally {
      f.stop();
    }
  });
}

// A summary is a wire value. Property insertion order is not newer usage.
Deno.test("equal usage summaries with reordered wire fields share one acquisition", async () => {
  const entry = shellEntry("s"), version = { generation: 2, revision: 3 };
  const value = detail(version);
  entry.digest.turns.turn = knownDerived(value.summary, "source", 1);
  const f = fixture(entry);
  try {
    const pending = f.owner.load(target);
    await flush();
    const reordered = {
      ...value.summary,
      tokens: {
        cache: { write: 0, read: 0 },
        reasoning: 0,
        output: 1,
        input: 7,
      },
    };
    entry.digest.turns.turn = knownDerived(reordered, "source", 1);
    f.owner.receive("server", { t: "index.patch", rev: 1, ops: [] });
    f.reads[0].result.resolve(value);
    await pending;
    await flush();
    assertEquals(f.reads.length, 1);
    f.owner.receive("server", { t: "index.patch", rev: 2, ops: [] });
    await flush();
    assertEquals(f.reads.length, 1);
    assertEquals(f.owner.get(target)?.summary, value.summary);
  } finally {
    f.stop();
  }
});

Deno.test("a settled usage result covers a later equal index summary in another wire order", async () => {
  const entry = shellEntry("s"), version = { generation: 2, revision: 3 };
  const value = detail(version);
  entry.digest.turns.turn = knownDerived(
    detail(version, 1).summary,
    "source",
    1,
  );
  const f = fixture(entry);
  try {
    const pending = f.owner.load(target);
    await flush();
    f.reads[0].result.resolve(value);
    await pending;
    const reordered = Object.fromEntries(
      Object.entries(value.summary).reverse(),
    ) as typeof value.summary;
    entry.digest.turns.turn = knownDerived(reordered, "source", 2);
    f.owner.receive("server", { t: "index.patch", rev: 1, ops: [] });
    await flush();
    assertEquals(f.reads.length, 1);
    assertEquals(f.owner.get(target)?.summary, value.summary);
  } finally {
    f.stop();
  }
});

for (const covered of [true, false]) {
  Deno.test(`same-source summary publication ${covered ? "covered by" : "newer than"} a held usage result ${covered ? "joins" : "refreshes"} it`, async () => {
    const entry = shellEntry("s"), version = { generation: 2, revision: 3 };
    entry.digest.turns.turn = knownDerived(
      detail(version, 1).summary,
      "source",
      1,
    );
    const f = fixture(entry);
    try {
      const pending = f.owner.load(target);
      await flush();
      entry.digest.turns.turn = knownDerived(
        detail(version).summary,
        "source",
        1,
      );
      for (let rev = 1; rev <= 2; rev++) {
        f.owner.receive("server", { t: "index.patch", rev, ops: [] });
      }
      f.reads[0].result.resolve(detail(version, covered ? 7 : 1));
      await pending;
      await flush();
      assertEquals(f.reads.length, covered ? 1 : 2);
      if (!covered) {
        const successor = f.owner.load(target);
        f.reads[1].result.resolve(detail(version));
        await successor;
      }
      await flush();
      assertEquals(f.reads.length, covered ? 1 : 2);
      assertEquals(f.owner.get(target)?.summary.tokens.input, 7);
    } finally {
      f.stop();
    }
  });
}
