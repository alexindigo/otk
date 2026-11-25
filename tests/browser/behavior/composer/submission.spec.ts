// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import { prompt, reply } from "../../pages/composer.ts";
import { revealTool, shellRun } from "../../pages/transcript.ts";

test.use({ profile: "composer-submission" });
for (const path of ["normal", "shell", "slash", "palette"] as const) {
  test(`composer.${path}-submission-promotes-once-and-persists-success`, {
    tag: ["@composer", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: `Submit ${path}`,
    });
    const frames = await wire(page);
    await openSession(state, page, session.id);
    await expect(
      page.locator(`.otk-tab[data-kind=phantom] [data-tab="${session.id}"]`),
    ).toBeVisible();
    await expect.poll(() =>
      frames.sent.some(({ frame }) => frame.method === "sessions.seen")
    ).toBe(true);
    expect(
      (await state.product("projects.list", {})).find((project) =>
        project.directory === state.directory
      ),
    ).toBeUndefined();
    const before = Date.now(), start = frames.sent.length;
    const unconfirmed = state.controller.info!.version.startsWith("2.") &&
      (path === "slash" || path === "palette");
    for (let turn = 0; turn < 2; turn++) {
      const text = `Submission ${path} turn ${turn} completed.`;
      if (path !== "shell") {
        await state.queue([text]);
      }
      if (path === "palette") {
        await page.keyboard.press("Control+k");
        await page.locator("input[name=command-search]").fill(
          "Submission owner probe",
        );
        await page.locator('[data-command="server.command:probe"]').click();
        if (unconfirmed) {
          await expect(page.locator("dialog[open]")).toContainText(
            "did not provide a way to confirm its message",
          );
          await page.keyboard.press("Escape");
        }
        await expect(page.locator("dialog[open]")).toHaveCount(0);
      } else {
        if (path === "shell") {
          await prompt(page).press("!");
          await expect(page.locator(".otk-prompt > label")).toHaveText("Shell");
        }
        await prompt(page).fill(
          path === "shell"
            ? `printf 'SUBMISSION-SHELL-${turn}'`
            : path === "slash"
            ? `/probe turn-${turn}`
            : `SUBMISSION-NORMAL-${turn}`,
        );
        await page.locator(".otk-prompt button[type=submit]").click();
        if (unconfirmed) {
          // WP1.9: uncertainty keeps the submitted input in custody, not in
          // the fresh composer. Recovery only checks the existing send.
          await expect(prompt(page)).toHaveValue("");
          await expect(
            page.getByRole("button", { name: "Check send", exact: true }),
          ).toHaveCount(turn + 1);
          await expect(page.locator(".otk-composer-notice")).toContainText(
            "did not provide a way to confirm its message",
          );
        } else await expect(prompt(page)).toHaveValue("");
      }
      if (path === "shell") {
        await revealTool(
          page,
          // NT2: a V2 user shell is a plugin shell record; V1 keeps its bash tool.
          `${
            shellRun(state, "completed")
          }:has([title*="SUBMISSION-SHELL-${turn}"])`,
        );
        await expect(
          page.locator(shellRun(state, "completed")).filter({
            hasText: `SUBMISSION-SHELL-${turn}`,
          }),
        ).toBeVisible();
      } else await reply(state, page, session.id, text);
      if (unconfirmed && path === "slash" && turn === 0) {
        for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
          await state.product("prefs.set", { key: "theme", value: theme });
          await expect(page.locator("html")).toHaveAttribute(
            "data-otk-theme",
            theme,
          );
          await info.attach(`send-unconfirmed-${theme}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
          });
        }
      }
      const tasks = await state.product("tasks.list", {
        directory: state.directory,
      });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].sessions).toEqual([session.id]);
      await expect(
        page.locator(
          `.otk-tab[data-kind=task] [data-tab="${
            tasks[0].id
          }"][aria-selected=true]`,
        ),
      ).toBeVisible();
      await expect(
        page.locator(`.otk-tab[data-kind=phantom] [data-tab="${session.id}"]`),
      ).toHaveCount(0);
      const sent = frames.sent.slice(start).map(({ frame }) => frame);
      const method = path === "shell"
        ? "session.shell"
        : path === "normal"
        ? "session.prompt"
        : "session.command";
      expect(sent.filter((frame) => frame.method === "tasks.create"))
        .toHaveLength(1);
      expect(sent.filter((frame) => frame.method === method)).toHaveLength(
        turn + 1,
      );
      await expect.poll(() =>
        frames.sent.slice(start).filter(({ frame }) =>
          frame.method === "projects.visit"
        ).length
      ).toBe(turn + 1);
    }
    const project = (await state.product("projects.list", {})).find((project) =>
      project.directory === state.directory
    )!;
    expect(project.lastVisit).toBeGreaterThanOrEqual(before);
    const task =
      (await state.product("tasks.list", { directory: state.directory }))[0];
    await page.reload();
    await expect(
      page.locator(
        `.otk-tab[data-kind=task] [data-tab="${task.id}"][aria-selected=true]`,
      ),
    ).toBeVisible();
    await expect(
      page.locator(`[data-crumb="${session.id}"][aria-current=page]`),
    ).toBeVisible();
    await expect(prompt(page)).toBeVisible();
  });
}
