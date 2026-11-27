// SPDX-License-Identifier: LGPL-3.0-only
import { expect, test } from "../../fixtures/evidence.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";

test("messages.session-link-restored-without-sidebar-row", {
  tag: "@messages",
}, async ({ state, page }) => {
  const { id } = await state.native<{ id: string }>("/session", "POST", {
    title: "Parent conversation",
  });
  const child = await state.native<{ id: string }>("/session", "POST", {
    parentID: id,
    title: "Settings design with the user",
  });
  const raw = child.id.slice(child.id.indexOf("-") + 1);
  const unknown = "ses_000000000000UnknownSession";
  await openSession(state, page, id);
  await state.product("layout.patch", { rightCollapsed: true });
  await expect(page.locator('aside[data-side="right"]')).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  const reply = page.locator('[data-role="assistant"]');
  await state.queue([`Follow up in \`${raw}\`. Unresolved: \`${unknown}\`.`]);
  await prompt(page, "Which helper handled settings?");
  await expect(reply.getByText(unknown, { exact: true })).toBeVisible();
  await expect(page.locator(".otk-turn-time")).toHaveText(/^Worked for /);
  await page.reload();
  await expect(page.locator('aside[data-side="right"]')).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  const link = reply.getByRole("link", {
    name: "Settings design with the user",
  });
  await expect(link).toBeVisible();
  await expect(link.locator(".otk-status-light")).toBeVisible();
  await expect(reply.locator("code").filter({ hasText: unknown }))
    .toBeVisible();
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/${child.id}$`));
});

test(
  "messages.session-link-opens-referenced-session",
  { tag: "@messages" },
  async ({
    state,
    page,
    context,
  }) => {
    const parent = await state.native<{ id: string }>("/session", "POST", {
      title: "Release preparation",
    });
    const title = "Review release notes";
    const child = await state.native<{ id: string }>("/session", "POST", {
      parentID: parent.id,
      title,
    });
    const unknown = "ses_000000000000UnknownSession";
    const nativeID = child.id.slice(child.id.indexOf("-") + 1);
    const reply =
      `Read the findings in (${nativeID}), or open \`${child.id}\`.\n\nUnresolved reference: \`${unknown}\`.`;
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await state.product("prefs.set", { key: "theme", value: "otk-dark" });
    await openSession(state, page, parent.id);
    await state.queue([reply]);
    await prompt(page, "Where are the release notes?");
    const message = page.locator('[data-role="assistant"]');
    const paragraphs = message.locator(".otk-prose-paragraph");
    const links = message.getByRole("link");
    const link = message.getByRole("link", { name: title, exact: true })
      .first();
    await expect(message.getByText(unknown, { exact: true })).toBeVisible();
    await expect(links).toHaveCount(2);
    await expect(link).toHaveClass(/\botk-entity-pill\b/);
    await expect(link.locator(".otk-status-light")).toBeVisible();
    await expect(link).toHaveAccessibleName(title);
    const capture = process.env.OTK_SESSION_LINK_SCREENSHOTS;
    if (capture) {
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        "otk-dark",
      );
      await page.screenshot({
        path: `${capture}/dark-rest.png`,
        animations: "disabled",
      });
      await link.hover();
      await expect(page.getByRole("tooltip")).toContainText(title);
      await page.screenshot({
        path: `${capture}/dark-hover.png`,
        animations: "disabled",
      });
      await page.mouse.move(0, 0);
    }
    await paragraphs.first().evaluate((paragraph) => {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = globalThis.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.keyboard.press("Control+c");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(`Read the findings in (${nativeID}), or open ${child.id}.`);
    await page.evaluate(() => globalThis.getSelection()?.removeAllRanges());
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${child.id}$`));
    await expect(page.locator(`[data-crumb="${child.id}"]`)).toBeVisible();
    const history = page.getByRole("navigation", { name: "Session history" });
    await history.getByRole("button").first().click();
    await expect(page).toHaveURL(new RegExp(`/${parent.id}$`));
    const referenced = links.and(message.locator(`a[href$="/${child.id}"]`))
      .first();
    await expect(referenced).toBeVisible();
    await history.getByRole("button").last().click();
    await expect(page).toHaveURL(new RegExp(`/${child.id}$`));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/${parent.id}$`));
    await expect(referenced).toBeVisible();
    await referenced.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/${child.id}$`));
    await history.getByRole("button").first().click();
    await expect(page).toHaveURL(new RegExp(`/${parent.id}$`));
    await expect(referenced).toBeVisible();

    const renamed =
      "Review the release notes and verify the complete documentation before publishing to the production channel";
    await state.product("session.rename", {
      sessionID: child.id,
      title: renamed,
    });
    await expect(referenced).toHaveAccessibleName(renamed);
    await referenced.focus();
    await expect(page.getByRole("tooltip")).toContainText(renamed);
  },
);
