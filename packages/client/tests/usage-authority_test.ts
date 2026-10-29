// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type TranscriptVersion,
  type TurnUsageDetail,
  UsageLedger,
} from "@otk/protocol";
import { fixtureMessagePolicy } from "../../../tests/support/message-pages.ts";
import type { SidecarConnection } from "../connection.ts";
import { createSessionUsage } from "../session-usage.ts";

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
function fixture() {
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
  const owner = createSessionUsage(() => connection);
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
