// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resources, test } from "../support/resources.ts";
import { nativeFixture } from "../support/native-fixture.ts";
import { waitFor } from "../support/opencode.ts";

test("native public endpoint keeps its initial socket instead of rebinding a released address", async () => {
  const listen = Deno.listen;
  const rebindings: number[] = [];
  // A competing listener wins any relinquished explicit TCP address. Port-zero
  // admission is atomic and never exposes such an address to the competitor.
  Deno.listen = ((options: Deno.ListenOptions) => {
    if (options.port) {
      rebindings.push(options.port);
      const competing = listen(options);
      resources().defer("competing public endpoint", () => competing.close());
    }
    return listen(options);
  }) as typeof Deno.listen;
  try {
    const fixture = await nativeFixture();
    const tools = await fixture.oc.request<string[]>("/experimental/tool/ids");
    assert(tools.length > 0, "Consumer must reach the admitted real native");
    assertEquals(rebindings, []);
  } finally {
    Deno.listen = listen;
  }
});

test("native generation reallocates a proven occupied private port without borrowing its listener", async () => {
  const f = await nativeFixture();
  await f.oc.stop();
  const foreign = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () => {
      foreignRequests++;
      return new Response("unrelated listener");
    },
  );
  let foreignRequests = 0;
  const occupied = foreign.addr.port, publicURL = f.oc.url;
  f.oc.nativePort = occupied;
  try {
    await f.oc.restart();
    assert(f.oc.nativePort !== occupied);
    assertEquals(f.oc.url, publicURL);
    assertEquals(
      foreignRequests,
      0,
      "Startup must not connect to a foreign listener",
    );
    assertEquals(
      await (await fetch(`http://127.0.0.1:${occupied}`)).text(),
      "unrelated listener",
    );
    assertEquals(foreignRequests, 1);
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Reallocated real native" },
    });
    f.fake.queue({ chunks: ["Actual native reply after port collision."] });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: { parts: [{ type: "text", text: "Prove reallocated native" }] },
    });
    const messages = await waitFor(
      () =>
        f.oc.request<
          {
            info: { role: string; time: { completed?: number } };
            parts: { type: string; text?: string }[];
          }[]
        >(`/session/${session.id}/message`),
      (rows) =>
        rows.some((row) =>
          row.info.role === "assistant" && !!row.info.time.completed
        ),
    );
    assert(
      messages.some((row) =>
        row.parts.some((part) =>
          part.type === "text" &&
          part.text === "Actual native reply after port collision."
        )
      ),
    );
    assertEquals(foreignRequests, 1);
    assertEquals(
      (f.oc.log.match(/Native pre-admission port collision;/g) ?? []).length,
      1,
    );
  } finally {
    await foreign.shutdown();
  }
});

test("native startup does not reallocate unrelated pre-readiness failures", async () => {
  const f = await nativeFixture();
  await f.oc.stop();
  const port = f.oc.nativePort;
  await Deno.writeTextFile(
    join(f.oc.root, "config/opencode/opencode.json"),
    "{invalid config",
  );
  await assertRejects(() => f.oc.restart(), Error);
  assertEquals(f.oc.nativePort, port);
  assertEquals(
    (f.oc.log.match(/Native pre-admission port collision;/g) ?? []).length,
    0,
  );
});
