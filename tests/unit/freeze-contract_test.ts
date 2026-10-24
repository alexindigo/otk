// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { FreezeProxy } from "../support/freeze-proxy.ts";
import { test, withResources } from "../support/resources.ts";
import { serve } from "../support/http.ts";

test("byte freezing makes no HTTP inventory claim while the HTTP boundary observes every keepalive request", async () => {
  const requests: string[] = [], ports = new Set<number>();
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request, info) => {
      requests.push(new URL(request.url).pathname);
      ports.add(info.remoteAddr.port);
      return new Response(null, { headers: { "content-length": "0" } });
    },
  );
  const proxy = new FreezeProxy(server.addr.port),
    client = await Deno.connect({ hostname: "127.0.0.1", port: proxy.port });
  try {
    for (const path of ["/session/status", "/permission", "/question"]) {
      const request = new TextEncoder().encode(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`,
      );
      let written = 0;
      while (written < request.length) {
        written += await client.write(request.subarray(written));
      }
      let header = "";
      while (!header.includes("\r\n\r\n")) {
        const bytes = new Uint8Array(4096), count = await client.read(bytes);
        assert(count !== null);
        header += new TextDecoder().decode(bytes.subarray(0, count));
      }
      assert(header.startsWith("HTTP/1.1 200"));
    }
    assertEquals(requests, ["/session/status", "/permission", "/question"]);
    assertEquals(ports.size, 1);
    assert(
      !("requests" in proxy),
      "A TCP byte freezer cannot advertise an incomplete HTTP inventory",
    );
  } finally {
    client.close();
    await proxy.stop();
    await server.shutdown();
  }
});

test("unexpected proxy connection failures reach the owning fixture instead of a detached rejection", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  const error = await assertRejects(() =>
    withResources("refused upstream", async () => {
      const proxy = new FreezeProxy(port);
      const socket = await Deno.connect({
        hostname: "127.0.0.1",
        port: proxy.port,
      });
      try {
        await socket.read(new Uint8Array(1));
      } finally {
        socket.close();
      }
      await proxy.stop();
    })
  );
  assert(
    JSON.stringify(error, Object.getOwnPropertyNames(error)).includes(
      "freeze proxy",
    ),
  );
});
