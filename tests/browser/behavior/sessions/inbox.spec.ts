// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { activity } from "../../pages/sessions.ts";

test.describe("inbox ownership", () => {
  test.use({ profile: "contract-sessions-inbox" });
  test("sessions.inbox-clock-ageing-view-action-reset-and-inactive-pause", {
    tag: ["@sessions", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    await state.product("projects.visit", {
      directory: state.directory,
      active: true,
    });
    await page.addInitScript(
      "(()=>{globalThis.inboxNow=Date.now();Date.now=()=>globalThis.inboxNow;const interval=globalThis.setInterval;globalThis.setInterval=(fn,delay,...args)=>{if(delay===30000)globalThis.inboxTick=fn;return interval(fn,delay,...args)}})()",
    );
    await page.goto(state.url);
    await expect(page.locator(".otk-project-row")).toHaveCount(4);
    const row = page.locator(
      `[data-project=${JSON.stringify(state.directory)}]`,
    );
    const project = (await state.product("inbox.get", {})).inbox.projects.find(
      (p) => p.directory === state.directory,
    )!;
    for (const [hours, level] of [[0, 0], [2, 1], [8, 2], [24, 3]]) {
      await page.evaluate(
        `inboxNow=${project.lastVisit + hours * 3600000};inboxTick()`,
      );
      await expect(row.locator(".otk-project-name")).toHaveClass(
        new RegExp(`otk-age-${level}`),
      );
    }
    await state.product("prefs.set", { key: "reducedColors", value: true });
    await expect(page.locator("html")).toHaveAttribute(
      "data-otk-reduced-colors",
      "",
    );
    await expect(row.locator(".otk-project-name")).toHaveCSS(
      "text-decoration-style",
      "double",
    );
    await state.product("prefs.set", { key: "reducedColors", value: false });
    await page.evaluate(
      "inboxNow=performance.timeOrigin+performance.now();inboxTick()",
    );
    await row.locator(".otk-project-open").click();
    await expect(row.locator("time")).toHaveText("now");
    const opened =
      (await state.product("inbox.get", {})).inbox.projects.find((p) =>
        p.directory === state.directory
      )!.lastVisit;
    expect(opened).toBeGreaterThanOrEqual(project.lastVisit);
    await openSession(state, page, "tstv1-otk");
    await expect.poll(async () =>
      !!(await state.product("inbox.get", {})).inbox.seen["tstv1-otk"]
    ).toBe(true);
    const visit =
      (await state.product("inbox.get", {})).inbox.projects.find((p) =>
        p.directory === state.directory
      )!.lastVisit;
    await page.evaluate(`inboxNow=${visit + 3600000};inboxTick()`);
    await expect(row.locator("time")).toHaveText("1h");
    await prompt(page, "Reset the project visit");
    await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
    await expect.poll(async () =>
      (await state.product("inbox.get", {})).inbox.projects.find((p) =>
        p.directory === state.directory
      )!.lastVisit
    ).toBeGreaterThan(opened);
    await page.evaluate(
      "inboxNow=performance.timeOrigin+performance.now();inboxTick()",
    );
    await expect(row.locator("time")).toHaveText("now");
    await row.locator(".otk-project-menu > button").click();
    await row.locator(".otk-menu-items button").click();
    await page.locator(".otk-inactive-toggle").click();
    await expect(row).toBeVisible();
    const paused = await row.locator("time").textContent();
    await page.evaluate("inboxNow+=100*3600000;inboxTick()");
    await expect(row.locator("time")).toHaveText(paused!);
  });
  test(
    "sessions.inbox-add-empty-scanned-project-width-reload-and-retained-draft",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      const { root, entries } = await state.observe<
        { root: string; entries: { id: string; directory: string }[] }
      >();
      await state.product("projects.templates", {
        templates: [root + "/projects/{project}"],
      });
      await page.goto(state.url);
      await page.getByRole("button", { name: "Add project", exact: true })
        .click();
      await expect(page.locator(".otk-template-paths button")).toHaveCount(4);
      await page.locator(".otk-template-paths button").first().click();
      await expect(page.locator("input[name=directory]")).not.toHaveValue("");
      const empty = root + "/empty-project";
      await page.locator("input[name=directory]").fill(empty);
      await page.locator("dialog .otk-form button[type=submit]").click();
      await expect(page.locator(".otk-session-view")).toBeVisible();
      await expect(page.locator(`[data-project=${JSON.stringify(empty)}]`))
        .toBeVisible();
      expect(
        (await state.product("inbox.get", {})).inbox.projects.find((p) =>
          p.directory === empty
        )?.added,
      ).toBe(true);
      const created = (await state.observe<
        { entries: { id: string; directory: string }[] }
      >()).entries.find((e) => e.directory === empty)!;
      expect(created).toBeTruthy();
      const separator = page.locator(".otk-inbox-resizer");
      await separator.click();
      await separator.press("End");
      await expect.poll(() =>
        page.locator(".otk-project-inbox").evaluate((e) =>
          e.getBoundingClientRect().width
        )
      ).toBe(360);
      await separator.press("Home");
      await expect.poll(() =>
        page.locator(".otk-project-inbox").evaluate((e) =>
          e.getBoundingClientRect().width
        )
      ).toBe(200);
      // Width paint is transient until the resize command persists its value.
      await expect.poll(async () =>
        (await state.product("prefs.get", {})).shellLayout.leftWidth
      ).toBe(200);
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`${created.id}$`));
      await expect.poll(() =>
        page.locator(".otk-project-inbox").evaluate((e) =>
          e.getBoundingClientRect().width
        )
      ).toBe(200);
      await page.setViewportSize({ width: 720, height: 800 });
      await expect(page.locator(".otk-project-inbox")).toHaveCSS(
        "position",
        "relative",
      );
      await openSession(state, page, "tstv1-otk");
      await page.locator("textarea[name=prompt]").fill("Keep this work");
      const target = page.locator(
        `[data-project=${
          JSON.stringify(entries[1].directory)
        }] .otk-project-open`,
      );
      await target.click();
      await expect(page).toHaveURL(/tstv1-atmosphera$/);
      await openSession(state, page, "tstv1-otk");
      await expect(page.locator("textarea[name=prompt]")).toHaveValue(
        "Keep this work",
      );
      await target.click();
      await expect(page).toHaveURL(/tstv1-atmosphera$/);
      await expect(page.locator("textarea[name=prompt]")).toHaveValue("");
    },
  );
  test(
    "sessions.reopening-selected-session-resets-visit-without-url-or-draft-replacement",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      await state.product("projects.visit", {
        directory: state.directory,
        active: true,
      });
      await openSession(state, page, "tstv1-otk");
      await expect.poll(async () =>
        !!(await state.product("inbox.get", {})).inbox.seen["tstv1-otk"]
      ).toBe(true);
      const before =
        (await state.product("inbox.get", {})).inbox.projects.find((p) =>
          p.directory === state.directory
        )!.lastVisit;
      await page.locator("textarea[name=prompt]").fill(
        "Keep this draft on the same session",
      );
      const url = page.url();
      await page.locator('[data-session="tstv1-otk"]').click();
      await expect.poll(async () =>
        (await state.product("inbox.get", {})).inbox.projects.find((p) =>
          p.directory === state.directory
        )!.lastVisit
      ).toBeGreaterThan(before);
      await expect(page).toHaveURL(url);
      await expect(page.locator("textarea[name=prompt]")).toHaveValue(
        "Keep this draft on the same session",
      );
    },
  );
});
test.describe("server merge", () => {
  test.use({ profile: "contract-sessions-merge" });
  test(
    "sessions.merged-servers-duplicate-name-labels-order-status-and-reload",
    { tag: ["@sessions", "@contracts", "@isolated"] },
    async ({ isolatedState: state, page }) => {
      const { remoteUrl, remoteEntries } = await state.observe<
        {
          remoteUrl: string;
          remoteEntries: { id: string; directory: string }[];
        }
      >();
      await page.goto(state.url);
      await expect(page.locator(".otk-project-row")).toHaveCount(4);
      await page.locator(".otk-settings-entry").click();
      await page.locator("input[name=url]").fill(remoteUrl);
      await page.locator("input[name=label]").fill("Build machine");
      await page.locator(
        ".otk-settings-content > .otk-form button[type=submit]",
      ).click();
      await expect(page.locator(".otk-project-row")).toHaveCount(8);
      await page.locator(".otk-settings .otk-view-header button").click();
      await expect(page.locator(".otk-settings")).toHaveCount(0);
      expect(await page.locator(".otk-project-machine").allTextContents())
        .toEqual([
          ...Array(4).fill("This server"),
          ...Array(4).fill("Build machine"),
        ]);
      const order = await page.locator(".otk-project-row").evaluateAll((es) =>
        es.map((e) => (e as HTMLElement).dataset.project)
      );
      await activity(state, "tstv1-luch", "hold");
      await expect(
        page.locator(
          `[data-project=${JSON.stringify(remoteEntries[3].directory)}]`,
        ),
      ).toHaveAttribute("data-rollup", "working");
      expect(
        await page.locator(".otk-project-row").evaluateAll((es) =>
          es.map((e) => (e as HTMLElement).dataset.project)
        ),
      ).toEqual(order);
      await page.reload();
      await expect(page.locator(".otk-project-row")).toHaveCount(8);
      expect(
        await page.locator(".otk-project-row").evaluateAll((es) =>
          es.map((e) => (e as HTMLElement).dataset.project)
        ),
      ).toEqual(order);
    },
  );
});
