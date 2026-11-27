// SPDX-License-Identifier: LGPL-3.0-only
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { cssLength } from "../../pages/css-length.ts";
import { focusNotifications, toast } from "../../pages/notifications.ts";
import { viewByUrl } from "../../pages/sessions.ts";

test("attention.notifications-name-the-background-project-and-task", {
  tag: ["@attention", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const exec = promisify(execFile);
  const key = join(state.directory, "fixture-signing-key");
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const makeProject = async (name: string, task: string, title: string) => {
    const directory = join(state.directory, name);
    await mkdir(directory);
    const git = (...args: string[]) => exec("git", ["-C", directory, ...args]);
    await git("init", "--quiet");
    await git("config", "gpg.format", "ssh");
    await git("config", "user.signingkey", key);
    await git(
      "-c",
      "user.name=OTK Fixture",
      "-c",
      "user.email=fixture@otk.invalid",
      "commit",
      "-S",
      "--quiet",
      "--allow-empty",
      "-m",
      name,
    );
    const session = await state.product("session.create", { directory, title });
    await state.product("tasks.create", {
      directory,
      name: task,
      sessions: [session.id],
    });
    return { name, task, title, session };
  };
  const atlas = await makeProject("Atlas", "Roadmap", "Review milestones");
  const beacon = await makeProject(
    "Beacon",
    "Release checklist",
    "Check packaging and confirm the signed release artifacts",
  );
  const current = await state.product("session.create", {
    directory: join(state.directory, atlas.name),
    title: "Current conversation",
  });
  await page.setViewportSize({ width: 1440, height: 860 });
  await openSession(state, page, current.id);
  await focusNotifications(page);
  for (const project of [atlas, beacon]) {
    await expect(
      page.locator(".otk-project-open").and(page.getByRole("button", {
        name: `Open project ${project.name}`,
        exact: true,
      })),
    ).toBeVisible();
  }
  await page.clock.install();
  const running = [atlas, beacon];
  const gates = new Set<string>();
  const release = async (gate: string) => {
    await state.release(gate);
    gates.delete(gate);
  };
  const short = page.locator(toast(atlas.session.id));
  const background = page.locator(toast(beacon.session.id));
  const cards = page.locator('.otk-toast[data-kind="done"]');
  const dismiss = { name: "Dismiss notification", exact: true };
  const capture = async (shape: string) => {
    for (
      const [theme, label] of [["otk-dark", "dark"], [
        "otk-light",
        "linen",
      ]] as const
    ) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await page.screenshot({
        path: info.outputPath(`toast-${label}-${shape}.png`),
        fullPage: true,
        animations: "disabled",
      });
    }
  };
  const box = async (card: typeof short) => (await card.boundingBox())!;
  const near = (actual: number, expected: number, label: string) =>
    expect.soft(Math.abs(actual - expected), label).toBeLessThanOrEqual(0.5);
  try {
    for (const { session } of running) {
      await openSession(state, page, session.id);
      const { gate } = await state.queue(["Review complete"], "held");
      gates.add(gate);
      await state.product("session.prompt", {
        sessionID: session.id,
        mode: "normal",
        parts: [{ kind: "text", text: "Finish the background work" }],
      });
      await expect(page.locator(`[data-session="${session.id}"]`))
        .toHaveAttribute("data-status", "busy");
    }
    // Go straight to the observer, without a project-default action that
    // would first select Atlas's running session and acknowledge its result.
    await viewByUrl(state, page, current.id);
    await expect(page.locator(`[data-crumb="${current.id}"]`)).toBeVisible();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 100));
    const [first, second] = [...gates];
    await release(first);
    await expect(short.getByRole("button", { name: atlas.title }))
      .toBeVisible();
    await expect(cards).toHaveCount(1);
    const shortWidth = (await box(short)).width;
    const gap = await cssLength(short, "--space-2");
    const shortTarget = (await short.locator(".otk-toast-session")
      .boundingBox())!;
    const shortClose =
      (await short.getByRole("button", dismiss).boundingBox())!;
    near(
      shortClose.x - shortTarget.x - shortTarget.width,
      gap,
      "short toast gap before X",
    );
    await capture("short");

    await release(second);
    await expect(cards).toHaveCount(2);
    const [shortInStack, longInStack] = await Promise.all([
      box(short),
      box(background),
    ]);
    expect.soft(longInStack.width, "widest toast enlarges the stack")
      .toBeGreaterThan(shortWidth);
    near(shortInStack.x, longInStack.x, "aligned start edges");
    near(shortInStack.width, longInStack.width, "equal widths");
    await capture("stack");
  } finally {
    for (const gate of gates) await state.release(gate);
  }
  for (const { name, task, title, session } of running) {
    const card = page.locator(toast(session.id));
    await expect(card, `${name} completion`).toContainText("Session done");
    await expect(card.locator(".otk-toast-project-name")).toHaveText(name);
    await expect(card.locator(".otk-project-avatar")).toBeVisible();
    await expect(card.locator(".otk-toast-task")).toBeVisible();
    await expect(card.locator(".otk-toast-task")).toHaveText(task);
    await expect(card.getByRole("button", { name: title, exact: true }))
      .toBeVisible();
  }
  await expect(cards).toHaveCount(2);
  await expect(page).toHaveURL(new RegExp(`${current.id}$`));
  const project = background.locator(".otk-toast-project");
  const task = background.locator(".otk-toast-task");
  const session = background.locator(".otk-toast-session");
  const [projectBox, taskBox, sessionBox] = await Promise.all([
    project.boundingBox(),
    task.boundingBox(),
    session.boundingBox(),
  ]);
  expect(projectBox!.x + projectBox!.width).toBeLessThan(taskBox!.x);
  expect(taskBox!.x + taskBox!.width).toBeLessThan(sessionBox!.x);
  const center = (box: NonNullable<typeof projectBox>) =>
    box.y + box.height / 2;
  expect(Math.abs(center(projectBox!) - center(taskBox!))).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(center(taskBox!) - center(sessionBox!))).toBeLessThanOrEqual(
    1,
  );
  const stackWidth = (await box(background)).width;
  await short.getByRole("button", dismiss).click();
  await expect(cards).toHaveCount(1);
  near(
    (await box(background)).width,
    stackWidth,
    "stack uses widest natural width",
  );
  await capture("long");
  await state.product("layout.patch", { rightCollapsed: true });
  await expect(page.locator(".otk-app")).toHaveAttribute(
    "data-right-collapsed",
    "true",
  );
  await page.setViewportSize({ width: 900, height: 860 });
  await expect(session).toBeHidden();
  await expect(task).toBeVisible();
  await expect(project).toBeVisible();
  await expect(page.locator(".otk-main")).not.toHaveAttribute("inert", "");
  await expect(background.getByRole("button", dismiss)).toBeInViewport({
    ratio: 1,
  });
  const whole = await background.locator(".otk-toast-location").evaluate(
    (row) => {
      const bounds = row.getBoundingClientRect();
      return Array.from(row.children).filter((item) =>
        item.getClientRects().length
      )
        .every((item) => {
          const r = item.getBoundingClientRect();
          return r.left >= bounds.left - 0.5 && r.right <= bounds.right + 0.5;
        });
    },
  );
  expect(whole, "the remaining facts fit without clipping").toBe(true);
  await page.setViewportSize({ width: 1440, height: 860 });
  await expect(session).toBeVisible();
  await page.setViewportSize({ width: 440, height: 860 });
  await expect(session).toBeHidden();
  await expect(project).toBeVisible();
  await expect(project).toContainText("Beacon");
  await expect(
    background.getByRole("button", {
      name: "Dismiss notification",
      exact: true,
    }),
  ).toBeVisible();
});
