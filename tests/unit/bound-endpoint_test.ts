// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FreezeProxy } from "../support/freeze-proxy.ts";
import { serve } from "../support/http.ts";
import { test } from "../support/resources.ts";

test("eight concurrent fixture origins own distinct sockets through a restart", async () => {
  const stacks = await Promise.all(Array.from({ length: 8 }, async (_, id) => {
    const origin = new FreezeProxy();
    const url = `http://127.0.0.1:${origin.port}`;
    const start = (generation: number) =>
      serve(
        { hostname: "127.0.0.1", port: 0, onListen() {} },
        () => Response.json({ id, generation }),
      );
    const first = start(1);
    origin.retarget(first.addr.port);
    const read = () => fetch(url, { signal: AbortSignal.timeout(5000) });
    assertEquals(await (await read()).json(), { id, generation: 1 });
    origin.retarget();
    await first.shutdown();
    // A different allocator cannot take the public port during the outage.
    assertThrows(
      () => Deno.listen({ hostname: "127.0.0.1", port: origin.port }),
      Deno.errors.AddrInUse,
    );
    await assertRejects(read, TypeError);
    const second = start(2);
    origin.retarget(second.addr.port);
    assertEquals(await (await read()).json(), { id, generation: 2 });
    return [origin.port, second.addr.port];
  }));
  assertEquals(new Set(stacks.flat()).size, 16);
});
