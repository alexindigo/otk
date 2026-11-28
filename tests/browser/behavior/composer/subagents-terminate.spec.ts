// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { messages } from "../../pages/composer.ts";

for (const key of ["Enter", "Space"] as const) {
  test(`composer.subagents-terminate-with-${key.toLowerCase()}`, {
    tag: ["@composer", "@sessions", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const title = "Review helper";
    const root = await state.native<{ id: string }>("/session", "POST", {
      title: "Parent session",
    });
    const child = await state.native<{ id: string }>("/session", "POST", {
      title,
      parentID: root.id,
    });
    const frames = await wire(page);
    const aborts = () =>
      frames.sent.filter(({ frame }) => frame.method === "session.abort")
        .map(({ frame }) => frame.params?.sessionID);
    const held = await state.queue(["Hold the helper"], "held");
    try {
      await state.native(`/session/${child.id}/prompt_async`, "POST", {
        parts: [{ type: "text", text: "Keep working until terminated" }],
      });
      await openSession(state, page, root.id);
      await expect.poll(async () => {
        const { requests } = await state.observe<{ requests: unknown[] }>();
        return JSON.stringify(requests).includes(
          "Keep working until terminated",
        );
      }).toBe(true);

      const pill = page.getByRole("button", { name: "Subagents: 1 running" });
      const menu = page.getByRole("menu", { name: "Subagents", exact: true });
      const rowTitle = page.getByText(title, { exact: true });
      const open = menu.getByRole("menuitem").filter({ has: rowTitle });
      const label = `Terminate ${title}`;
      const terminate = menu.getByRole("menuitem", {
        name: label,
        exact: true,
      });

      await pill.click();
      await expect(terminate).toBeVisible();
      await expect(open).toBeVisible();
      await terminate.hover();
      await expect(terminate).toHaveAttribute("title", label);
      await expect(terminate.locator("svg path")).toHaveAttribute(
        "d",
        "m6 6 12 12M18 6 6 18",
      );
      await expect(terminate.locator("svg rect")).toHaveCount(0);
      const target = (await terminate.boundingBox())!;
      const navigation = (await open.boundingBox())!;
      expect(target.x - navigation.x - navigation.width).toBeGreaterThan(0);
      const controlSize = await terminate.evaluate((button) => {
        const probe = document.createElement("span");
        probe.style.cssText = "display:block;width:var(--control-size)";
        button.append(probe);
        const width = probe.getBoundingClientRect().width;
        probe.remove();
        return width;
      });
      expect(target.width).toBeCloseTo(controlSize, 1);
      expect(target.height).toBeCloseTo(controlSize, 1);
      await open.getByText(title, { exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${child.id}$`));
      await expect(menu).toBeHidden();
      expect(aborts()).toEqual([]);

      await openSession(state, page, root.id);
      await pill.click();
      await open.focus();
      await page.keyboard.press("End");
      await expect(terminate).toBeFocused();
      await page.keyboard.press(key);
      await expect.poll(aborts).toEqual([child.id]);
      await expect.poll(async () =>
        JSON.stringify(await messages(state, child.id))
      )
        .toMatch(/Abort|interrupt/i);
      await expect(terminate).toHaveCount(0);
    } finally {
      await state.release(held.gate);
    }
  });
}
