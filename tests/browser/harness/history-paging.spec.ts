// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "@playwright/test";
import { acquireOlderHistory } from "../pages/history.ts";

test("messages.history-paging-leaves-follow-with-native-input", {
  tag: ["@messages", "@contracts", "@harness"],
}, async ({ page }) => {
  // Model the viewport's input boundary: programmatic scrollIntoView does not
  // express reader intent. Only a trusted upward wheel releases tail-follow.
  await page.setContent(`
    <style>
      .otk-messages { height: 200px; overflow: auto; }
      .source { height: 1200px; }
      .otk-load-older { pointer-events: none; }
      [data-reader] .otk-load-older { pointer-events: auto; }
    </style>
    <div class="otk-messages">
      <div class="otk-message-flow" data-message-count="10">
        <button class="otk-load-older">Load older messages</button>
        <div class="source">Acquired messages</div>
      </div>
    </div>
    <script>
      const pane = document.querySelector('.otk-messages');
      const flow = document.querySelector('.otk-message-flow');
      pane.scrollTop = pane.scrollHeight;
      pane.addEventListener('wheel', event => {
        if (event.isTrusted && event.deltaY < 0) pane.dataset.reader = 'true';
      });
      document.querySelector('button').addEventListener('click', event => {
        if (!event.isTrusted || !pane.dataset.reader) return;
        flow.dataset.messageCount = String(Number(flow.dataset.messageCount) + 10);
        if (flow.dataset.messageCount === '30') event.target.remove();
      });
    </script>
  `);
  await acquireOlderHistory(page, 30);
  await expect(page.locator(".otk-messages")).toHaveAttribute(
    "data-reader",
    "true",
  );
  await expect(page.locator(".otk-load-older")).toHaveCount(0);
  await expect(page.locator(".otk-message-flow")).toHaveAttribute(
    "data-message-count",
    "30",
  );
});

test("messages.history-paging-retains-click-failures-without-progress", {
  tag: ["@messages", "@contracts", "@harness"],
}, async ({ page }) => {
  await page.setContent(`
    <div class="otk-message-flow" data-message-count="10">
      <button class="otk-load-older" style="pointer-events: none">
        Load older messages
      </button>
    </div>
  `);
  await expect(acquireOlderHistory(page, 30)).rejects.toThrow(/locator.click/);
  await expect(page.locator(".otk-message-flow")).toHaveAttribute(
    "data-message-count",
    "10",
  );
});
