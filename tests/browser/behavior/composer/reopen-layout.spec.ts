// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { seed, tool } from "../../pages/attention.ts";
import { prompt } from "../../pages/transcript.ts";

test.use({ profile: "isolated", viewport: { width: 1280, height: 800 } });

test("composer.reopen-text-clears-toolbar", {
  tag: ["@composer", "@visual", "@isolated"],
}, async ({ page, isolatedState: state }, info) => {
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await state.product("prefs.set", { key: "textSize", value: "125" });
  await state.product("prefs.set", { key: "theme", value: "otk-dark" });
  await state.product("layout.patch", { leftWidth: 200, rightWidth: 300 });
  const parent = await seed(state, "Execution and dependency review");
  const child = await seed(
    state,
    "Validate the release configuration",
    parent.id,
  );
  await seed(state, "Review the reporting and evaluation contracts", parent.id);
  await seed(state, "Summarize the browser verification evidence", parent.id);
  await seed(state, "Confirm the transitive dependency inventory", child.id);
  await openSession(state, page, parent.id);
  await state.queue(["Dependency report complete."]);
  await prompt(
    page,
    "Inventory the dependencies in the release configuration.",
  );
  await expect(page.locator(".otk-messages")).toContainText(
    "Dependency report complete.",
  );
  await tool(state, "bash", {
    command: "printf review-dependencies",
    description: "Review dependencies",
  });
  await state.queue(["The configuration is ready."]);
  await state.native(`/session/${child.id}/prompt_async`, "POST", {
    parts: [{ type: "text", text: "Validate the release configuration" }],
  });
  const dock = page.locator(".otk-composer-dock");
  const permission = page.locator(".otk-permission-dock");
  const reopen = dock.getByRole("button", {
    name: "Pending permission: reopen",
  });
  await permission.getByRole("button", { name: "Dismiss locally" }).click();
  await expect(reopen).toBeVisible();
  const sidebar = page.locator(".otk-right-panel");
  // The reported frame is narrower than the persisted resize minimum.
  await sidebar.evaluate((el) => (el as HTMLElement).style.width = "230px");
  await expect(sidebar).toHaveCSS("width", "230px");
  await sidebar.locator(`[data-session="${child.id}"]`).hover();
  if (process.env.OTK_ROW_META_CAPTURE) {
    await page.screenshot({
      path: info.outputPath("review-sessions-230-dark.png"),
      animations: "disabled",
    });
  }
  const facts = await dock.evaluate((root) => {
    const shown = (el: Element) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        getComputedStyle(el).visibility === "visible" &&
        !el.closest("[inert], [hidden]");
    };
    const toolbar = root.querySelector(".otk-prompt-actions")!;
    const controls = Array.from(
      toolbar.querySelectorAll("button, [role=button], input"),
    ).filter(shown);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const overlaps = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const el = node.parentElement;
      if (!el || !node.textContent?.trim() || !shown(el)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const text of Array.from(range.getClientRects())) {
        for (const control of controls) {
          if (control.contains(el)) continue;
          const box = control.getBoundingClientRect();
          const x = Math.min(text.right, box.right) -
            Math.max(text.left, box.left);
          const y = Math.min(text.bottom, box.bottom) -
            Math.max(text.top, box.top);
          if (x > .5 && y > .5) {
            overlaps.push({
              text: node.textContent.trim(),
              control: control.getAttribute("aria-label") ??
                control.textContent?.trim(),
              x,
              y,
            });
          }
        }
      }
    }
    return { controls: controls.length, overlaps };
  });
  await info.attach("toolbar-geometry", {
    body: JSON.stringify(facts),
    contentType: "application/json",
  });
  expect.soft(facts.controls).toBeGreaterThan(0);
  expect.soft(facts.overlaps).toEqual([]);
  await reopen.click();
  await permission.getByRole("button", { name: "Allow once", exact: true })
    .click();
  await expect.poll(async () =>
    JSON.stringify(await state.native(`/session/${child.id}/message`))
  )
    .toContain("The configuration is ready.");
});
