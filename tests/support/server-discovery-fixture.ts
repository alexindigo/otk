// SPDX-License-Identifier: LGPL-3.0-only
// Native peers for the real-browser discovery contract. No product test hooks.
import { nativeBehavior } from "./native-testing.ts";
import { withResources } from "./resources.ts";
import { serve } from "./http.ts";
import { freePort } from "./opencode.ts";

await withResources("server discovery browser peers", async () => {
  const f = await nativeBehavior();
  const local = await f.sidecar();
  const origin = local.url;
  const alternate = origin.replace("127.0.0.1", "localhost");
  const blocked = await f.sidecar();
  const allowed = await f.sidecar({ server: { origins: [origin] } });
  const setup = await f.sidecar({
    server: { origins: [origin] },
    auth: { type: "" },
  });
  const password = await f.sidecar({
    server: { origins: [origin, alternate] },
    auth: {
      type: "password",
      username: "tester",
      password: "secret",
      secretkey: "01234567890123456789012345678901",
    },
  });
  const foreign = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      Response.json({ error: "Unauthorized" }, {
        status: 401,
        headers: { "Access-Control-Allow-Origin": "*" },
      }),
  );
  const held = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (req) =>
      new Promise<Response>((resolve) =>
        req.signal.addEventListener(
          "abort",
          () => resolve(new Response(null, { status: 499 })),
          { once: true },
        )
      ),
  );
  console.log(
    "SD3 " + JSON.stringify({
      local: origin,
      blocked: blocked.url,
      allowed: allowed.url,
      password: password.url,
      setup: setup.url,
      native: f.oc.url,
      refused: `http://127.0.0.1:${await freePort()}`,
      foreign: `http://127.0.0.1:${(foreign.addr as Deno.NetAddr).port}`,
      held: `http://127.0.0.1:${(held.addr as Deno.NetAddr).port}`,
    }),
  );
  // The browser fixture closes stdin after its pages; resource cleanup joins every peer.
  for await (
    const _chunk of Deno.stdin.readable
  ) { /* input is only a lifetime lease */ }
});
