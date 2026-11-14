// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { badge } from "../../pages/notifications.ts";

test.use({ profile: "contract-visual-styles" });
test("attention.failure-toast-burst-grouping-and-mixed-overflow", {
  tag: ["@attention", "@visual", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await page.goto(state.url + "/?scene=failures");
  await page.getByRole("button", { name: "Repeat failure", exact: true })
    .click();
  const failure = page.locator(".otk-toast[data-kind=error]");
  await expect(failure).toHaveCount(1);
  await badge(page, 0);
  await expect(failure).toContainText("22 identical failures");
  await expect(failure).toContainText("Loading permission requests failed");
  await expect(failure).toContainText("The native session was not found");
  await expect(failure).toContainText("Open the session to review");
  await expect(failure.getByRole("link", { name: "Failure fixture" }))
    .toHaveAttribute("href", "#/local/opcv2-ses_scene");
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await page.evaluate(`styleTest.theme('${theme}')`);
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await info.attach(`failure-toast-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
  await page.getByRole("button", { name: "Mixed notifications", exact: true })
    .click();
  await badge(page, 2);
  await expect(page.locator("[data-note-count]")).toHaveAttribute(
    "data-note-count",
    "7",
  );
  const seen = new Set<string>();
  for (let n = 0; n < 7; n++) {
    const visibleFailures =
      (await page.locator(".otk-toast[data-kind=error]").allTextContents())
        .reduce(
          (sum, text) =>
            sum + Number(text.match(/(\d+) identical failures/)?.[1] ?? 1),
          0,
        );
    const visibleQuestions = await page.locator(
      ".otk-toast[data-kind=question]",
    ).count();
    const remaining = 26 - visibleFailures;
    await expect(page.locator(".otk-toasts-more")).toHaveText(
      [
        remaining
          ? `${remaining} more ${remaining === 1 ? "failure" : "failures"}`
          : "",
        2 - visibleQuestions ? `${2 - visibleQuestions} more need you` : "",
      ].filter(Boolean).join(", "),
    );
    for (const title of await page.locator(".otk-toast").allTextContents()) {
      seen.add(title);
    }
    await expect(page.locator(".otk-toasts-more")).not.toContainText(
      "failures need you",
    );
    await page.locator(".otk-toasts-more").click();
  }
  expect(seen.size).toBe(7);
  await expect(page.locator("[data-note-count]")).toHaveAttribute(
    "data-note-count",
    "7",
  );
});

test("attention.oversized-failure-keeps-complete-reason-reachable", {
  tag: ["@attention", "@visual", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 600, height: 300 });
  await page.goto(state.url + "/?scene=failures");
  await page.getByRole("button", { name: "Long failure", exact: true }).click();
  const toast = page.locator(".otk-toast");
  await expect(toast).toHaveCount(1);
  const region = toast.locator(".otk-scroll");
  expect(await region.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  );
  await region.evaluate((el) => el.scrollTop = el.scrollHeight);
  await expect(toast.getByRole("button", { name: "Dismiss", exact: true }))
    .toBeInViewport();
  expect(
    await toast.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    }),
  ).toBe(true);
  await expect(toast).toContainText("END OF REASON");
  const geometry = await toast.evaluate((el) => {
    const header = el.querySelector("header")!.getBoundingClientRect();
    const actions = el.querySelector(".otk-toast-actions")!
      .getBoundingClientRect();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent!.indexOf("END OF REASON");
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 13);
      const end = range.getBoundingClientRect();
      return {
        flowing: actions.top >= header.bottom,
        reachable: end.top >= 0 && end.bottom <= innerHeight,
      };
    }
    return { flowing: false, reachable: false };
  });
  expect(geometry).toEqual({ flowing: true, reachable: true });
});
