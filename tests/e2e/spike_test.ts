// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FakeLlm } from "../support/fake-llm.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { SidecarTest } from "../support/sidecar.ts";
import { Cdp } from "../support/cdp.ts";

Deno.test("E0 native Solid 2.0 counter renders and responds through the sidecar", async () => {
  const fake = new FakeLlm(), oc = await OpencodeTest.start(fake);
  let sidecar: SidecarTest | undefined, browser: Cdp | undefined;
  try {
    sidecar = await SidecarTest.start(oc);
    const html = await fetch(sidecar.url).then((response) => response.text());
    for (const path of ["/login", "/setup", "/nested/route", "/assets/"]) {
      const response = await fetch(sidecar.url + path);
      assertEquals(response.status, 200);
      assertEquals(await response.text(), html);
    }
    const missingApi = await fetch(sidecar.url + "/api/missing");
    assertEquals(missingApi.status, 404);
    await missingApi.text();
    const assetPath = /src="([^"]+\.js)"/.exec(html)![1];
    const asset = await fetch(new URL(assetPath, sidecar.url + "/"));
    assertEquals(asset.status, 200);
    assertEquals(
      asset.headers.get("content-type"),
      "text/javascript; charset=utf-8",
    );
    await asset.text();
    browser = await Cdp.launch(oc.root);
    await browser.goto(sidecar.url);
    await browser.poll("document.querySelector('button')?.textContent === '0'");
    await browser.click("button");
    await browser.poll("document.querySelector('button')?.textContent === '1'");
    assertEquals(browser.errors, []);
    const screenshot = join(oc.root, "e0-native-counter.png");
    await browser.screenshot(screenshot);
    console.info("E0 Chromium capture:", screenshot);
  } finally {
    await browser?.close();
    await sidecar?.stop();
    await oc.stop();
    await fake.stop();
  }
});
