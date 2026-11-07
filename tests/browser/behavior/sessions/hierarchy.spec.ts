// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "contract-sessions-hierarchy" });
test("sessions.task-hierarchy-filter-preview-draft-promotion-and-reload", {
  tag: ["@sessions", "@contracts", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const task = await state.product("tasks.create", {
    directory: state.directory,
    name: "Execution",
    sessions: ["tstv1-otk"],
  });
  await openSession(state, page, "tstv1-otk");
  await page.locator("[data-session=tstv1-helper]").click();
  await expect(page).toHaveURL(/#\/local\/tstv1-otk\/tstv1-helper$/);
  expect(
    await page.locator(".otk-session-group").evaluateAll((groups) =>
      groups.map((e) => ({
        title: e.getAttribute("aria-label"),
        ids: Array.from(
          document.querySelectorAll(".otk-project-session-tree [role=group]"),
        ).filter((g) =>
          g.getAttribute("aria-label") === e.getAttribute("aria-label")
        ).map((g) =>
          (g.querySelector("[data-session]") as HTMLElement).dataset.session
        ),
      }))
    ),
  ).toEqual([{
    title: "Execution",
    ids: ["tstv1-otk", "tstv1-helper", "tstv1-nested"],
  }, {
    title: "Not in a task",
    ids: ["tstv1-finished", "tstv1-preview", "tstv1-blocked"],
  }]);
  await expect(
    page.locator("[data-session=tstv1-nested]").locator(
      "xpath=ancestor::*[@data-depth][1]",
    ),
  ).toHaveAttribute("data-depth", "2");
  for (
    const [id, status] of [["tstv1-otk", "working"], [
      "tstv1-blocked",
      "blocked",
    ], ["tstv1-finished", "finished"]]
  ) {
    await expect(page.locator(`[data-session=${id}] .otk-status-light`))
      .toHaveAttribute("data-state", status);
  }
  const search = page.locator("input[type=search]");
  await search.fill("references");
  await expect(page.locator("[data-session]")).toHaveCount(3);
  await expect(page.locator("[data-session=tstv1-nested]")).toBeVisible();
  await search.fill("no such title");
  await expect(page.locator(".otk-project-sessions")).toContainText(
    "No matching sessions",
  );
  await search.fill("");
  await page.locator("[data-session=tstv1-preview]").click();
  await expect(
    page.locator("[data-tab=tstv1-preview]").locator(
      "xpath=ancestor::*[contains(@class,'otk-tab')][1]",
    ),
  ).toHaveAttribute("data-preview", "true");
  await expect(page.locator(".otk-messages")).toContainText(
    "Transcript for preview",
  );
  await page.locator("textarea[name=prompt]").fill("Keep this draft");
  await page.locator("[data-session=tstv1-blocked]").click();
  await expect(page).toHaveURL(/tstv1-blocked$/);
  await page.locator("[data-session=tstv1-preview]").click();
  await expect(page).toHaveURL(/#\/local\/tstv1-preview$/);
  await expect(page.locator("textarea[name=prompt]")).toHaveValue(
    "Keep this draft",
  );
  await page.locator("textarea[name=prompt]").fill("");
  await page.locator("[data-session=tstv1-preview]").dblclick();
  await expect(
    page.locator(".otk-tab[data-kind=task]").filter({
      hasText: "Idle preview",
    }),
  ).toBeVisible();
  expect(await state.product("tasks.list", { directory: state.directory }))
    .toHaveLength(2);
  await page.locator("[data-session=tstv1-nested]").click();
  await expect(page).toHaveURL(/#\/local\/tstv1-otk\/tstv1-nested$/);
  await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".otk-messages")).toContainText(
    "Transcript for nested",
  );
  await page.reload();
  await expect(page.locator("[data-session=tstv1-nested]")).toHaveAttribute(
    "aria-current",
    "page",
  );
});
