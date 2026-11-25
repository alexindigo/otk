// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { expandTool, openRecord } from "../../pages/transcript.ts";

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
