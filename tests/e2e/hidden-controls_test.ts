// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Cdp } from "../support/cdp.ts";
import { fixture } from "../support/config.ts";
import { serve } from "../support/http.ts";
import { resources, test } from "../support/resources.ts";

test("shared native control paint preserves hidden semantics through removal and restoration", async () => {
  const root = await fixture();
  const css = await Deno.readTextFile(
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
  const browser = await Cdp.launch(root);
  try {
    await browser.goto(`http://127.0.0.1:${server.addr.port}`);
    await browser.poll("!!document.querySelector('#available')");
    const hidden = () =>
      browser.evaluate(
        "[...document.querySelectorAll('[hidden]')].map(el=>[el.id,getComputedStyle(el).display,el.getClientRects().length])",
      );
    assertEquals(await hidden(), [["action", "none", 0], ["group", "none", 0]]);
    await browser.evaluate(
      "document.querySelector('#action').hidden=false;document.querySelector('#group').hidden=false",
    );
    await browser.poll(
      "document.querySelector('#action').getClientRects().length>0&&document.querySelector('#group').getClientRects().length>0",
    );
    await browser.evaluate(
      "document.querySelector('#action').hidden=true;document.querySelector('#group').hidden=true",
    );
    assertEquals(await hidden(), [["action", "none", 0], ["group", "none", 0]]);
    assertEquals(browser.errors, []);
  } finally {
    await browser.close();
  }
});
