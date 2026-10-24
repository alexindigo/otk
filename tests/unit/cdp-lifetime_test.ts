// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { Cdp } from "../support/cdp.ts";
import { resources, test } from "../support/resources.ts";

test("CDP send failure releases its pending timer and transport closure rejects owned commands", async () => {
  const root = await resources().tempDir("cdp-"),
    browser = await Cdp.launch(root);
  const original = WebSocket.prototype.send;
  try {
    WebSocket.prototype.send = () => {
      throw new Error("controlled send failure");
    };
    await assertRejects(
      () => browser.send("Runtime.enable"),
      Error,
      "controlled send failure",
    );
  } finally {
    WebSocket.prototype.send = original;
  }
  assertEquals(await browser.evaluate("6 * 7"), 42);
  const pending = browser.send("Runtime.evaluate", {
    expression: "new Promise(() => {})",
    awaitPromise: true,
  });
  const rejected = assertRejects(() => pending, Error, "CDP closed");
  await browser.close();
  await rejected;
});
