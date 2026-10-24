// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { uiConsumer } from "../support/ui-consumer.ts";

test("successful prompt clears its submitted draft despite failed project visit and shows separate feedback", async () => {
  const f = await uiConsumer("?secondary-failures"), b = f.browser;
  try {
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const [index, theme] of ["dark", "light"].entries()) {
      await b.click(`[data-${theme}]`);
      await b.fill(".otk-prompt textarea", "Submit exactly once");
      await b.click(".otk-send-button");
      await b.poll(
        `document.querySelector('[data-sent]')?.textContent==='${index + 1}'`,
      );
      await b.poll(
        "document.querySelector('.otk-prompt textarea')?.value===''",
      );
      await b.poll(
        "document.querySelector('[data-bookkeeping]')?.textContent.includes('Visit storage unavailable')",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('.otk-prompt [role=alert]')?.textContent ?? ''",
        ),
        "",
      );
      assertEquals(b.errors, []);
      const shots = Deno.env.get("OTK_B5_SECONDARY_SHOTS");
      if (shots) {
        await b.evaluate(
          "document.activeElement?.blur();document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
        );
        await b.screenshot(join(shots, `quality-B5-secondary-${theme}.png`));
      }
    }
  } catch (error) {
    console.error(
      "Secondary consumer diagnostics",
      b.errors,
      await b.evaluate("document.body.innerHTML"),
    );
    throw error;
  } finally {
    await f.close();
  }
});
