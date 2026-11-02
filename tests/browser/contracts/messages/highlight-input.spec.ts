// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";

test.use({ profile: "contract-messages-highlight" });
test(
  "messages.equal-code-input-no-work",
  { tag: ["@messages", "@contracts"] },
  async ({ isolatedState: state, page }) => {
    await page.addInitScript(`(()=>{
    const Native=Worker;globalThis.codeWork={sent:0,received:0};globalThis.codePending=new Set();
    globalThis.Worker=class extends Native {
      constructor(...args){super(...args);this.addEventListener('message',({data})=>{codeWork.received++;if(['ready','done','error'].includes(data.type))codePending.delete(data.id)})}
      postMessage(value,...args){codeWork.sent++;for(const request of Array.isArray(value)?value:[value]){if(['prepare','capture'].includes(request.type))codePending.add(request.id)}return super.postMessage(value,...args)}
    };
  })()`);
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await expect(
      page.locator(".otk-token").filter({ hasText: /^stableValue$/ }),
    ).toHaveCount(1);
    await expect.poll(() => page.evaluate("codePending.size")).toBe(0);
    const before = await page.evaluate("codeWork") as {
      sent: number;
      received: number;
    };
    await page.evaluate(
      "globalThis.codeNode=document.querySelector('.otk-code');globalThis.codeTokens=[...codeNode.querySelectorAll('.otk-token')]",
    );
    for (let index = 0; index < 3; index++) {
      await state.controller.call("scenario", {
        lease: state.lease.lease,
        action: "release",
      });
      await expect(page.locator(".otk-messages")).toContainText(
        `Replacement ${index}`,
      );
      // Join the replacement's render/task boundary, not a timed quiet window.
      await page.evaluate(() =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const channel = new MessageChannel();
              channel.port1.onmessage = () => {
                channel.port1.close();
                channel.port2.close();
                resolve();
              };
              channel.port2.postMessage(null);
            })
          )
        )
      );
      expect(await page.evaluate("codeWork")).toEqual(before);
      expect(
        await page.evaluate(
          "codeNode===document.querySelector('.otk-code')&&codeTokens.every((node,index)=>node===codeNode.querySelectorAll('.otk-token')[index])",
        ),
      ).toBe(true);
    }
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "succeed",
    });
    await expect(
      page.locator(".otk-token").filter({ hasText: /^changedValue$/ }),
    ).toHaveCount(1);
    expect(await page.evaluate<number>("codeWork.sent")).toBeGreaterThan(
      before.sent,
    );
  },
);
