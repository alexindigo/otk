// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../fixtures/evidence.ts";
import { receivedPrompt } from "../fixtures/provider.ts";

test(
  "smoke.native-prompt",
  { tag: ["@smoke", "@smoke.native-prompt", "@transport"] },
  async ({ state, page }) => {
    const seed = await state.native<{ id: string }>("/session", "POST", {
      title: "Smoke seed",
    });
    await page.goto(state.url);
    await page.locator(
      `[data-project=${JSON.stringify(state.directory)}] .otk-project-open`,
    ).click();
    await expect(page.locator("textarea[name=prompt]")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${seed.id}$`));
    await page.getByRole("navigation", { name: "Task sessions" }).getByRole(
      "button",
      { name: "Session", exact: true },
    )
      .click();
    await expect(page).toHaveURL(/#\/local\/opcv1-/);
    await expect(page).not.toHaveURL(new RegExp(`${seed.id}$`));
    const id = new URL(page.url()).hash.split("/").at(-1)!;
    const prompt = `Trusted native smoke ${state.lease.lease}`;
    const prefix = "A visible incremental prefix";
    const final = `${prefix} and its final suffix.`;
    const gate = await state.queue(
      [prefix, " and its final suffix."],
      "stepped",
    );
    const composer = page.locator("textarea[name=prompt]");
    await composer.fill(prompt);
    await composer.press("Enter");
    await expect.poll(async () => {
      const observation = await state.observe<{ requests: unknown[] }>();
      return receivedPrompt(observation.requests, prompt);
    }).toBe(true);
    await state.release(gate.gate);
    const reply = page.locator("[data-role=assistant] .otk-text");
    await expect(reply).toHaveText(prefix);
    await state.release(gate.gate);
    await expect(reply).toHaveText(final);
    await expect(
      page.getByRole("tablist", { name: "Tasks and active sessions" })
        .getByRole("tab", { selected: true }),
    )
      .toHaveAttribute("data-status", "idle");
    await expect(page).toHaveURL(new RegExp(`${id}$`));
    await page.reload();
    await expect(page.locator("[data-role=assistant] .otk-text")).toHaveText(
      final,
    );
    await expect(page.locator("textarea[name=prompt]")).toBeVisible();
  },
);
