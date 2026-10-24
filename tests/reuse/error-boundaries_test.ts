// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { test } from "../support/resources.ts";
import { uiConsumer } from "../support/ui-consumer.ts";

test("injected unknown failures remain visible in form preference and command consumers in both themes", async () => {
  const f = await uiConsumer("?error-boundaries"), b = f.browser;
  try {
    await b.send("Emulation.setDeviceMetricsOverride", {
      width: 1280,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await b.poll("!!document.querySelector('[data-login] input')");
    await b.fill("[data-login] input[name=username]", "consumer");
    await b.fill("[data-login] input[name=password]", "test input");
    for (
      const [kind, expected] of [["null", "Unknown error"], [
        "string",
        "Injected failure",
      ]]
    ) {
      await b.click(`[data-${kind}]`);
      for (
        const [control, region] of [
          ["[data-login] button[type=submit]", "data-login"],
          ["[data-preferences] input[name=reducedColors]", "data-preferences"],
          ['[data-command="consumer.failure"]', "data-palette"],
        ]
      ) {
        await b.click(control);
        await b.poll(
          `document.querySelector('[${region}] [role=alert]')?.textContent===${
            JSON.stringify(expected)
          }`,
        );
      }
      assertEquals(
        await b.evaluate(
          "document.querySelector('[data-login] input[name=username]').value",
        ),
        "consumer",
      );
      assertEquals(
        await b.evaluate(
          "document.querySelector('[data-preferences] input[name=reducedColors]').checked",
        ),
        false,
      );
      assertEquals(b.errors, []);
      if (kind === "string") {
        for (const theme of ["dark", "light"]) {
          await b.click(`[data-${theme}]`);
          const shots = Deno.env.get("OTK_B5_SHOTS");
          if (shots) {
            await b.evaluate(
              "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
            );
            await b.screenshot(join(shots, `quality-B5-errors-${theme}.png`));
          }
        }
      }
    }
  } finally {
    await f.close();
  }
});
