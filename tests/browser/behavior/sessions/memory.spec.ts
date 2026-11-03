// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { sessionContext } from "../../pages/sessions.ts";

test.use({ profile: "contract-sessions-memory" });
test(
  "sessions.project-memory-session-task-reload-closed-and-missing-fallback",
  { tag: ["@sessions", "@contracts", "@isolated"] },
  async ({ isolatedState: state, page }) => {
    const { entries } = await state.observe<
      { entries: { directory: string }[] }
    >();
    const directory = state.directory;
    const project = (path: string) =>
      page.locator(
        `.otk-project-row[data-project=${
          JSON.stringify(path)
        }] .otk-project-open`,
      );
    const task = await state.product("tasks.create", {
      directory,
      name: "Remember this task",
      sessions: ["tstv1-remembered"],
    });
    const restored = async () => {
      await expect(page).toHaveURL(/tstv1-remembered$/);
      await expect(page.locator(`[data-tab="${task.id}"]`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(page.locator(".otk-user-bubble")).toContainText(
        "Transcript for remembered",
      );
    };
    await openSession(state, page, "tstv1-remembered");
    await restored();
    await project(entries[1].directory).click();
    await expect(page).toHaveURL(/tstv1-atmosphera$/);
    await project(directory).click();
    await restored();
    await project(entries[1].directory).click();
    await expect(page).toHaveURL(/tstv1-atmosphera$/);
    await page.reload();
    await project(directory).click();
    await restored();
    await sessionContext(
      page,
      '[data-crumb="tstv1-remembered"]',
      "session.close",
    );
    await expect(page).toHaveURL(/#project\//);
    await project(entries[1].directory).click();
    await expect(page).toHaveURL(/tstv1-atmosphera$/);
    await page.reload();
    await project(directory).click();
    await expect(page).toHaveURL(/tstv1-otk$/);
    await expect(page.locator(".otk-user-bubble")).toContainText(
      "Transcript for otk",
    );
    await project(entries[1].directory).click();
    await expect(page).toHaveURL(/tstv1-atmosphera$/);
    await state.product("layout.location", {
      sidecarId: "local",
      directory,
      sessionID: "tstv1-missing",
    });
    await page.reload();
    await project(directory).click();
    await expect(page).toHaveURL(/tstv1-otk$/);
    await expect(page.locator(".otk-user-bubble")).toContainText(
      "Transcript for otk",
    );
    await expect.poll(async () =>
      (await state.product("prefs.get", {})).shellLayout.projectLocations?.find(
        (p) => p.directory === directory,
      )?.sessionID
    ).toBe("tstv1-otk");
  },
);
