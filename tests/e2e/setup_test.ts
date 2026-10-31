// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { test } from "../support/resources.ts";
import { browserFixture } from "../support/browser-fixture.ts";
import { WsClient } from "../support/ws-client.ts";

test("real setup password, cookie and fresh login reach the connected application", async () => {
  const f = await browserFixture();
  try {
    const server = await f.sidecar({ auth: { type: "" } }),
      b = await f.browser(server.url);
    await b.poll("!!document.querySelector('select[name=type]')");
    assertEquals(
      await b.evaluate("document.querySelector('select[name=type]').value"),
      "password",
    );
    await b.fill("input[name=username]", "geometry-user");
    await b.fill("input[name=password]", "geometry-password");
    await b.click(".otk-auth-view button[type=submit]");
    const connected =
      "!document.querySelector('.otk-auth-view')&&!!document.querySelector('.otk-corner-right:not(:disabled)')";
    await b.poll(connected);
    const setupCookies = await b.send("Network.getCookies");
    assert(
      (setupCookies.cookies as { httpOnly: boolean }[]).some((cookie) =>
        cookie.httpOnly
      ),
      "Setup completion installs its private cookie before connecting",
    );
    const fresh = await f.browser(server.url);
    await fresh.poll(
      "!!document.querySelector('.otk-auth-view input[name=password]')",
    );
    await fresh.fill("input[name=username]", "geometry-user");
    await fresh.fill("input[name=password]", "geometry-password");
    await fresh.click(".otk-auth-view button[type=submit]");
    await fresh.poll(connected);
    const cookies = await fresh.send("Network.getCookies");
    assert(
      (cookies.cookies as { httpOnly: boolean }[]).some((cookie) =>
        cookie.httpOnly
      ),
    );
    const noneServer = await f.sidecar({ auth: { type: "" } }),
      none = await f.browser(noneServer.url);
    await none.poll("!!document.querySelector('select[name=type]')");
    await none.evaluate(
      "(()=>{const e=document.querySelector('select[name=type]');e.value='none';e.dispatchEvent(new Event('change',{bubbles:true}))})()",
    );
    await none.click(".otk-auth-view button[type=submit]");
    await none.poll(connected);
    const openClient = new WsClient(noneServer.url);
    try {
      await openClient.connect();
    } finally {
      await openClient.close();
    }
  } finally {
    await f.stop();
  }
});
