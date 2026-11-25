// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import {
  expandTool,
  openRecord,
  readRecordBody,
} from "../../pages/transcript.ts";

for (const kind of ["tool", "record"]) {
  test(`messages.${kind}-disclosure-establishes-native-reader-intent`, {
    tag: ["@messages", "@contracts"],
  }, async ({ page }) => {
    // Real browser input at the helper boundary. Like the app's follow owner,
    // this fixture distinguishes native reader intent from pointer auto-scroll.
    await page.setContent(`
    <div class="otk-messages" aria-busy="false"
      style="height:200px;overflow:auto">
      <div style="height:400px"></div>
      <div data-inner style="height:140px;overflow:auto">
        <div style="height:400px">Nested tool output</div>
      </div>
      <section data-message="tool-owner" data-tool="reader-probe"
        data-native-record="reader-probe">
        <header class="otk-tool-state">
        <button class="otk-tool-toggle" aria-expanded="false">Tool</button>
        </header>
      </section>
      <div style="height:20px"></div>
    </div>
  `);
    await page.locator(".otk-messages").evaluate((pane) => {
      let reader = false;
      pane.scrollTop = pane.scrollHeight;
      pane.querySelector("[data-inner]")!.scrollTop = 100;
      pane.addEventListener("wheel", (event) => {
        if ((event as WheelEvent).deltaY < 0) reader = true;
      });
      const button = pane.querySelector("button")!;
      button.addEventListener("click", () => {
        button.setAttribute("aria-expanded", String(reader));
      });
    });
    if (kind === "tool") await expandTool(page, "[data-tool=reader-probe]");
    else await openRecord(page, "[data-native-record=reader-probe]");
    await expect(page.locator("button")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
}

test("messages.record-body-acquires-its-own-window-after-header-disclosure", {
  tag: ["@messages", "@contracts"],
}, async ({ page }) => {
  await page.setContent(`
    <div class="otk-messages" aria-busy="false"
      style="height:200px;overflow:auto">
      <section data-message="body-owner" data-native-record="body-probe">
        <header class="otk-tool-state">
          <button class="otk-tool-toggle" aria-expanded="false">Record</button>
        </header>
        <div class="otk-tool-body" hidden>
          <div style="height:400px">Native parameters</div>
          <div class="otk-text" style="height:48px"></div>
        </div>
      </section>
    </div>
  `);
  await page.locator(".otk-messages").evaluate((pane) => {
    const body = pane.querySelector<HTMLElement>(".otk-tool-body")!;
    const text = body.querySelector(".otk-text")!;
    pane.querySelector("button")!.addEventListener("click", (event) => {
      (event.currentTarget as HTMLElement).setAttribute(
        "aria-expanded",
        "true",
      );
      body.hidden = false;
    });
    new IntersectionObserver((entries) => {
      text.textContent = entries[0].isIntersecting ? "Windowed summary" : "";
    }, { root: pane }).observe(text);
  });
  await readRecordBody(page, '[data-native-record="body-probe"]');
  await expect(page.locator(".otk-text")).toHaveText("Windowed summary");
  await expect(page.locator(".otk-text")).toBeInViewport();
});
