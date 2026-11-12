// SPDX-License-Identifier: LGPL-3.0-only
import { mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt } from "../../pages/transcript.ts";
import { activity, visibleOnScreen } from "../../pages/sessions.ts";

test.describe("project catalog", () => {
  test.use({ profile: "contract-sessions-catalog" });
  test("sessions.project-catalog-discovery-activity-creation-and-collapse", {
    tag: ["@load", "@sessions", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const { root, entries } = await state.observe<
      { root: string; entries: { id: string; directory: string }[] }
    >();
    const row = (directory: string) =>
      page.locator(
        `.otk-project-row[data-project=${JSON.stringify(directory)}]`,
      );
    const empty = root + "/projects/empty",
      finished = root + "/projects/finished-discovery";
    await page.goto(state.url);
    // Session-bearing index-origin projects now belong to Active, not Discovered.
    await expect(page.locator(".otk-discovered-toggle")).toContainText("(1)");
    await expect(row(root + "/projects/linked")).toHaveCount(0);
    await expect(
      row(empty).getByRole("img", { name: "No known activity", exact: true }),
    ).toBeVisible();
    await expect(row(entries[1].directory).locator(".otk-status-light"))
      .toHaveAttribute("data-state", "none");
    await expect(row(entries[1].directory)).toHaveAttribute(
      "data-group",
      "active",
    );
    await expect(row(empty)).toHaveAttribute("data-group", "discovered");
    expect(
      await page.locator(".otk-inbox-scroll > *").evaluateAll((es) =>
        es.map((e) => e.className).filter((s) => s.includes("toggle"))
      ),
    ).toEqual(["otk-discovered-toggle", "otk-inactive-toggle"]);
    await openSession(state, page, "tstv1-atmosphera");
    await row(empty).locator(".otk-project-open").click();
    const inbox = (await state.product("inbox.get", {})).inbox;
    expect(
      inbox.projects.some((p) =>
        [empty, entries[1].directory].includes(p.directory)
      ),
    ).toBe(false);
    await row(entries[1].directory).locator(".otk-project-menu > button")
      .click();
    await page.getByRole("menuitem", { name: "Mark inactive", exact: true })
      .click();
    await expect(row(entries[1].directory)).toHaveCount(0);
    expect(
      (await state.product("inbox.get", {})).inbox.projects.find((p) =>
        p.directory === entries[1].directory
      )?.inactive,
    ).toBe(true);
    await page.locator(".otk-discovered-toggle").click();
    await expect(page.locator(".otk-discovered-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await activity(state, "tstv1-atmosphera", "hold");
    await activity(state, "tstv1-globnotes", "thaw");
    await activity(state, "tstv1-discovered-finish", "hold");
    await activity(state, "tstv1-discovered-finish", "release");
    for (
      const directory of [entries[1].directory, entries[2].directory, finished]
    ) await visibleOnScreen(row(directory));
    await page.reload();
    await expect(page.locator(".otk-discovered-toggle")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(row(empty)).toHaveCount(0);
    for (
      const [directory, status] of [[entries[1].directory, "working"], [
        entries[2].directory,
        "blocked",
      ], [finished, "finished"]]
    ) {
      await expect(row(directory)).toHaveAttribute("data-rollup", status);
      await visibleOnScreen(
        row(directory).locator(`.otk-status-light[data-state=${status}]`),
      );
    }
    await openSession(state, page, "tstv1-atmosphera");
    await expect(page.locator("[data-kind=phantom]").first()).toBeVisible();
    await activity(state, "tstv1-atmosphera", "release");
    await page.locator(".otk-discovered-toggle").click();
    await expect(row(empty)).toBeVisible();
    for (
      const [theme, name] of [["otk-dark", "dark"], ["otk-light", "linen"], [
        "otk-light-stone",
        "stone",
      ]]
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      // Rows are never lampless; discovered rows carry no evidence, so grey.
      await expect(
        page.locator(
          "[data-group=discovered] .otk-status-light:not([data-state=none])",
        ),
      ).toHaveCount(0);
      await expect(page.locator("[data-group=discovered] .otk-status-light"))
        .toHaveCount(
          await page.locator(".otk-project-row[data-group=discovered]").count(),
        );
      await page.screenshot({
        path: info.outputPath(`q1-${name}-column.png`),
        fullPage: true,
      });
      const centers = () =>
        page.locator(
          ".otk-project-row:not([data-inactive=true]) .otk-project-marker",
        ).evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return box.y + box.height / 2;
          })
        );
      const column = await centers();
      await page.getByRole("button", { name: "Collapse projects", exact: true })
        .click();
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        "true",
      );
      expect(await centers()).toEqual(column);
      // Rows are never lampless; discovered rows carry no evidence, so grey.
      await expect(
        page.locator(
          "[data-group=discovered] .otk-status-light:not([data-state=none])",
        ),
      ).toHaveCount(0);
      await expect(page.locator("[data-group=discovered] .otk-status-light"))
        .toHaveCount(
          await page.locator(".otk-project-row[data-group=discovered]").count(),
        );
      await page.screenshot({
        path: info.outputPath(`q1-${name}-rail.png`),
        fullPage: true,
      });
      await page.getByRole("button", { name: "Expand projects", exact: true })
        .click();
      await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
        "data-collapsed",
        "false",
      );
    }
    const positions = () =>
      page.locator(".otk-project-row[data-inactive=false] .otk-status-light")
        .evaluateAll((es) =>
          es.map((e) => {
            const r = e.getBoundingClientRect();
            return r.y + r.height / 2;
          })
        );
    const before = await positions();
    await page.getByRole("button", { name: "Collapse projects", exact: true })
      .click();
    await expect(page.locator(".otk-project-inbox")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(await positions()).toEqual(before);
    await expect(
      row(empty).getByRole("img", { name: "No known activity", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Expand projects", exact: true })
      .click();
    await row(empty).locator(".otk-project-menu > button").click();
    await expect(page.getByRole("menuitem")).toHaveText(["New session"]);
    await page.getByRole("menuitem").click();
    await expect(row(empty)).toHaveAttribute("data-source", "tracked");
    expect(
      (await state.observe<{ entries: { directory: string }[] }>()).entries
        .some((e) => e.directory === empty),
    ).toBe(true);
    await openSession(state, page, "tstv1-atmosphera");
    await prompt(page, "Track this interaction");
    await expect(row(entries[1].directory)).toHaveAttribute(
      "data-source",
      "tracked",
    );
  });
});

test("sessions.project-scan-retires-disconnected-work-current-connection-add", {
  tag: ["@sessions", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const directory = state.directory + "/scan-target";
  await mkdir(directory);
  // Use an independent project, not a nested scope coalesced into its checkout.
  await promisify(execFile)("git", ["init", "-b", "master", directory]);
  await state.product("projects.templates", { templates: [directory] });
  const frames = await wire(page);
  let holdWelcome = false;
  frames.hold((frame, request) =>
    (frame.t === "request.result" && request?.method === "projects.scan") ||
    holdWelcome
  );
  await page.goto(state.url);
  await page.getByRole("button", { name: "Add project", exact: true }).click();
  await expect.poll(() =>
    frames.held.filter((x) => x.request?.method === "projects.scan").length
  ).toBe(1);
  await expect(page.locator(".otk-template-paths")).toContainText(
    "Scanning directories…",
  );
  holdWelcome = true;
  frames.close();
  await expect.poll(() => frames.held.some((x) => x.frame.t === "welcome"))
    .toBe(true);
  await expect(page.locator("select[name=server] option:checked")).toHaveCount(
    0,
  );
  await expect(page.locator(".otk-template-paths")).not.toContainText(
    "Scanning directories…",
  );
  holdWelcome = false;
  for (let i = 0; i < frames.held.length;) {
    if (frames.held[i].request?.method !== "projects.scan") {
      frames.held.splice(i, 1)[0].deliver();
    } else i++;
  }
  await expect.poll(() =>
    frames.held.filter((x) => x.request?.method === "projects.scan").length
  ).toBe(2);
  frames.release();
  await expect(page.locator(".otk-template-paths button")).toHaveText(
    directory,
  );
  await page.locator(".otk-template-paths button").click();
  await page.locator("dialog[open] button[type=submit]").click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(page.locator(".otk-session-view")).toBeVisible();
  await expect(
    page.locator(
      `[data-project=${JSON.stringify(directory)}][data-source=tracked]`,
    ),
  ).toBeVisible();
  expect(
    (await state.product("inbox.get", {})).inbox.projects.some((p) =>
      p.directory === directory
    ),
  ).toBe(true);
});
