// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import {
  bounded,
  contextMenu,
  dismiss,
  menuLabels,
  pick,
  rightClick,
} from "../../pages/menus.ts";

test.use({ profile: "contract-menus-context" });
test(
  "menus.external-contributions-live-targets-native-keys-and-owner-teardown",
  { tag: ["@menus", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url);
    const inner = page.locator("#inner"), result = page.locator("#result");
    await expect(inner).toHaveAttribute("data-composed-ref", "yes");
    await rightClick(page, inner);
    expect(await menuLabels(page)).toEqual([
      "Inspect code",
      "Inspect original",
      "Close reply",
    ]);
    await expect(contextMenu(page).getByRole("group")).toHaveCount(2);
    await expect(contextMenu(page).getByRole("separator")).toHaveCount(2);
    await page.keyboard.press("End");
    await page.keyboard.press("Space");
    await expect(result).toHaveText("closed");
    await expect(contextMenu(page)).toHaveCount(0);
    await page.locator("#rename").click();
    await page.locator("#disable").click();
    await rightClick(page, inner);
    expect(await menuLabels(page)).toEqual(["Inspect code", "Inspect changed"]);
    await pick(page, "Inspect code");
    await expect(result).toHaveText("code:changed");
    await inner.click();
    await page.keyboard.press("Shift+F10");
    await expect(contextMenu(page)).toBeVisible();
    await dismiss(page);
    await expect(inner).toBeFocused();
    for (
      const edges of [
        "left:1px;top:1px",
        "right:1px;top:1px",
        "left:1px;bottom:1px",
        "right:1px;bottom:1px",
      ]
    ) {
      await inner.evaluate((el, edges) => {
        el.setAttribute(
          "style",
          "position:fixed;width:160px;height:40px;" + edges,
        );
        (el as HTMLElement).focus();
      }, edges);
      await page.keyboard.press("ContextMenu");
      await bounded(page);
      await expect.poll(() =>
        contextMenu(page).evaluate((el) => {
          const a = document.querySelector("#inner")!.getBoundingClientRect(),
            r = el.closest(".otk-surface")!.getBoundingClientRect();
          return r.bottom <= a.top + .5 || r.top >= a.bottom - .5 ||
            r.right <= a.left + .5 || r.left >= a.right - .5;
        })
      ).toBe(true);
      await dismiss(page);
    }
    await inner.evaluate((el) => el.removeAttribute("style"));
    await result.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
      (document.activeElement as HTMLElement).blur();
    });
    await page.keyboard.press("ContextMenu");
    expect(await menuLabels(page)).toEqual(["app"]);
    await dismiss(page);
    await inner.click();
    await page.keyboard.press("ContextMenu");
    await expect(contextMenu(page).getByRole("menuitem").first()).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(contextMenu(page)).toHaveCount(0);
    await expect(inner).toBeFocused();
    await rightClick(page, inner);
    const original = await contextMenu(page).elementHandle();
    await rightClick(page, contextMenu(page).getByRole("menuitem").first());
    expect(await menuLabels(page)).toEqual(["Inspect code", "Inspect changed"]);
    expect(
      await original!.evaluate((el) =>
        el === document.querySelector(":popover-open [role=menu]")
      ),
    ).toBe(true);
    await dismiss(page);
    // Cancellation is deliberately synthetic: no pointerup exists in this scenario.
    await inner.evaluate((el) => {
      el.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 2 }),
      );
      el.dispatchEvent(
        new PointerEvent("pointercancel", { bubbles: true, button: 2 }),
      );
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: r.x + 8,
          clientY: r.y + 8,
        }),
      );
    });
    expect(await menuLabels(page)).toEqual(["Inspect code", "Inspect changed"]);
    await dismiss(page);
    await rightClick(page, inner);
    await page.locator("#release-inner").evaluate((el) =>
      (el as HTMLElement).click()
    );
    await expect(contextMenu(page).getByRole("menuitem")).toHaveText([
      "Inspect changed",
      "probe.third",
    ]);
    await pick(page, "Inspect changed");
    await expect(result).toHaveText("changed");
    await page.locator("#open-modal").click();
    const modal = page.locator("dialog[open]"),
      trigger = modal.locator(".otk-display-menu > button");
    await trigger.click();
    await expect(
      modal.locator(
        '.otk-popover-panel[aria-label="Display preferences"]:popover-open',
      ),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(modal.locator(":popover-open")).toHaveCount(0);
    await expect(modal).toBeVisible();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(modal.locator(":popover-open")).toHaveCount(0);
    await page.keyboard.press("Shift+F10");
    await expect(modal.locator("[role=menu] button").first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(
      contextMenu(page).getByRole("menuitem", { name: "app", exact: true }),
    ).toBeFocused();
    await dismiss(page);
    await expect(trigger).toBeFocused();
    await expect(modal).toBeVisible();
    await expect(
      page.locator(
        '[role=menu][aria-label="Context menu"] [data-context-command]',
      ),
    ).toHaveCount(0);
    await expect(modal.locator('.otk-popover-panel[aria-label="Context menu"]'))
      .toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(modal).toHaveCount(0);
    await page.locator("#open-modal").click();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(modal.locator(":popover-open")).toHaveCount(0);
    await page.keyboard.press("ContextMenu");
    await expect(contextMenu(page)).toBeVisible();
    await page.locator("#remove-modal").evaluate((el) =>
      (el as HTMLElement).click()
    );
    await expect(page.locator("dialog")).toHaveCount(0);
    await expect(
      page.locator(
        ".otk-context-menu [data-context-command],.otk-popover-anchor",
      ),
    ).toHaveCount(0);
    await rightClick(page, inner);
    expect(await menuLabels(page)).toEqual(["Inspect changed", "probe.third"]);
    await page.locator("#toggle-menus").evaluate((el) =>
      (el as HTMLElement).click()
    );
    await expect(page.locator(".otk-context-menu,.otk-popover-anchor"))
      .toHaveCount(0);
    await page.locator("#toggle-menus").click();
    await rightClick(page, "#no-viewer");
    expect(await menuLabels(page)).toEqual(["Copy image address"]);
    await dismiss(page);
  },
);

test(
  "menus.reply-contributions-constant-count-and-complete-external-identity",
  { tag: ["@menus", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    await page.goto(state.url);
    await page.locator("#mount-transcript").click();
    await expect(page.locator("[data-message]")).toHaveCount(1);
    const count = await page.locator("#context-command-count").textContent();
    await rightClick(page, '[data-message="probe-reply-0"] .otk-text p');
    expect(await menuLabels(page)).toEqual([
      "Copy reply",
      "Inspect reply identity",
    ]);
    await pick(page, "Inspect reply identity");
    await expect.poll(async () =>
      JSON.parse((await page.locator("#reply-identity").textContent())!)
    ).toEqual({
      sidecarId: "probe-sidecar",
      sessionID: "tstv1-probe-session",
      messageID: "probe-reply-0",
      lastID: "probe-reply-0",
      completed: true,
      queued: false,
      directory: "/probe",
      text: "Reply 0",
    });
    await page.locator("#grow-transcript").click();
    await expect(page.locator("[data-message]")).toHaveCount(40);
    await expect(page.locator("#context-command-count")).toHaveText(count!);
    await rightClick(page, '[data-message="probe-reply-39"] .otk-text p');
    await pick(page, "Inspect reply identity");
    await expect(page.locator("#reply-identity")).toContainText(
      "probe-reply-39",
    );
  },
);

test("menus.project-dots-shared-projection-owned-failure-and-readiness", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await page.goto(state.url);
  await page.locator("#mount-project-probe").click();
  await rightClick(page, "#project-probe .otk-project-open");
  expect(await menuLabels(page)).toEqual(["Mark inactive"]);
  await dismiss(page);
  await page.locator("#project-probe .otk-project-menu button").focus();
  await page.keyboard.press("Enter");
  const dots = page.getByRole("menu", {
    name: "Project menu for probe",
    exact: true,
  });
  await expect(dots.getByRole("menuitem")).toHaveText(["Mark inactive"]);
  await expect(dots.getByRole("menuitem")).toBeFocused();
  await dots.getByRole("menuitem").click();
  const alert = page.locator("#project-probe .otk-project-error");
  await expect(alert).toHaveText("Could not finish this action. Try again");
  await expect.poll(() =>
    dots.getByRole("menuitem").evaluate((el) =>
      document.getElementById(el.getAttribute("aria-describedby")!) ===
        document.querySelector("#project-probe .otk-project-error")
    )
  ).toBe(true);
  await expect(dots.getByRole("alert")).toHaveCount(0);
  await expect.poll(() =>
    alert.evaluate((el) => {
      const row = document.querySelector("#project-probe [data-project]")!
          .getBoundingClientRect(),
        action = document.querySelector("#project-probe .otk-project-open")!
          .getBoundingClientRect(),
        r = el.getBoundingClientRect();
      return r.top >= action.bottom && r.bottom <= row.bottom &&
        r.left >= action.left && r.right <= row.right;
    })
  ).toBe(true);
  await page.locator("#disconnect-project").evaluate((el) =>
    (el as HTMLElement).click()
  );
  await expect(dots).not.toBeVisible();
});
