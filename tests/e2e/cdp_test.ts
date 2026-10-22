// SPDX-License-Identifier: LGPL-3.0-only
import { tempDir, test } from "../support/resources.ts";
import { assertEquals } from "@std/assert";
import { Cdp } from "../support/cdp.ts";

test("CDP clicks wait for rendered hit geometry before sending one native gesture", async () => {
  const root = await tempDir("cdp-");
  const browser = await Cdp.launch(root);
  const send = browser.send.bind(browser);
  let presses = 0;
  browser.send = async (method, params = {}) => {
    if (
      method === "Input.dispatchMouseEvent" && params.type === "mousePressed"
    ) {
      // Let the already-scheduled layout commit before input is delivered. This
      // controls ordering, not elapsed time, and never changes the click point.
      await browser.poll("globalThis.moved");
      presses++;
    }
    return await send(method, params);
  };
  try {
    for (
      const [content, clickCount] of [
        [
          "<details><summary>Failure details</summary><p>Provenance</p></details>",
          1,
        ],
        [
          '<button type="button" aria-expanded="false">Error details</button>',
          2,
        ],
      ] as const
    ) {
      await browser.evaluate(`(() => {
        document.body.innerHTML = ${JSON.stringify(content)};
        globalThis.moved = false;
        globalThis.clicks = [];
        const target = document.querySelector('summary,button');
        target.style.cssText = 'position:absolute;left:100px;top:100px;width:160px;height:30px';
        const rect = target.getBoundingClientRect.bind(target);
        target.getBoundingClientRect = () => {
          const measured = rect();
          delete target.getBoundingClientRect;
          requestAnimationFrame(() => {
            target.style.top = '240px';
            globalThis.moved = true;
          });
          return measured;
        };
        target.addEventListener('click', event => {
          clicks.push({trusted:event.isTrusted, count:event.detail});
          if (target.tagName === 'BUTTON') target.setAttribute('aria-expanded', 'true');
        });
      })()`);
      await browser.click("summary,button", clickCount);
      await browser.poll(
        "document.querySelector('details')?.open || document.querySelector('button')?.getAttribute('aria-expanded') === 'true'",
      );
      assertEquals(await browser.evaluate("clicks"), [{
        trusted: true,
        count: clickCount,
      }]);
    }
    assertEquals(presses, 2, "Readiness must not retry native gestures");
  } finally {
    await browser.close();
  }
});
