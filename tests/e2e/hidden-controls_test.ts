// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { serve } from "../support/http.ts";
import { resources, test } from "../support/resources.ts";
// Native removal/restoration is C13's Node contract; this is fixed hidden paint.
test("shared native control paint preserves hidden semantics through removal and restoration", async () => {
  const root = await fixture(),
    css = await Deno.readTextFile(
      new URL("../../packages/ui/theme.css", import.meta.url),
    );
  const server = serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      new Response(
        `<!doctype html><style>${css}</style><button id="action" class="otk-pill" hidden>Unavailable action</button><div id="group" class="otk-control-row" hidden><button>Unavailable group</button></div><button id="available">Available action</button>`,
        { headers: { "content-type": "text/html" } },
      ),
  );
  resources().defer("hidden control server", () => server.shutdown());
  const b = await Cdp.launch(root);
  try {
    await b.goto(`http://127.0.0.1:${server.addr.port}`);
    await b.poll("!!document.querySelector('#available')");
    assertEquals(
      await b.evaluate(
        "[...document.querySelectorAll('[hidden]')].map(el=>[el.id,getComputedStyle(el).display,el.getClientRects().length])",
      ),
      [["action", "none", 0], ["group", "none", 0]],
    );
    assertEquals(b.errors, []);
  } finally {
    await b.close();
  }
});
