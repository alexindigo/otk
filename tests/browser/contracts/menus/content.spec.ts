// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { openWorkLogs, revealAcquired } from "../../pages/transcript.ts";
import {
  clipboard,
  copied,
  menuLabels,
  pick,
  rightClick,
  sessionActions,
} from "../../pages/menus.ts";
test.use({ profile: "contract-menus-content" });
test("menus.content-targets-complete-source-code-hunks-and-feature-tools", {
  tag: ["@menus", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  await openWorkLogs(page);
  await clipboard(page);
  const open = async (selector: string) => {
    await revealAcquired(page, selector);
    await rightClick(page, page.locator(selector).first());
  };
  for (
    const [selector, expected, action, text] of [
      [".otk-user-bubble", ["Copy prompt"], "Copy prompt", "Prompt source"],
      [
        '[data-message="reply"] .otk-text p',
        ["Copy reply"],
        "Copy reply",
        "Reply source\n\nconst answer = 42;\n\n\nSecond reply step",
      ],
      [
        '[data-message="reply"] .otk-text .otk-code',
        ["Copy code", "Copy reply"],
        "Copy code",
        "const answer = 42;\n",
      ],
    ] as const
  ) {
    await open(selector);
    expect(await menuLabels(page)).toEqual([...expected, ...sessionActions]);
    await pick(page, action);
    await copied(page, text);
  }
  await open("[data-tool=bash] .otk-tool-toggle");
  expect(await menuLabels(page)).toEqual([
    "Copy command",
    "Copy output",
    "Expand",
    "Copy reply",
    ...sessionActions,
  ]);
  await pick(page, "Copy command");
  await copied(page, "printf context-output");
  await open("[data-tool=bash] .otk-tool-toggle");
  await pick(page, "Expand");
  await expect(page.locator("[data-tool=bash] .otk-tool-toggle"))
    .toHaveAttribute("aria-expanded", "true");
  await open("[data-tool=bash] .otk-tool-toggle");
  expect(await menuLabels(page)).toEqual([
    "Copy command",
    "Copy output",
    "Collapse",
    "Copy reply",
    ...sessionActions,
  ]);
  await pick(page, "Copy output");
  await copied(page, "context-output");
  await open("[data-tool=bash] .otk-tool-toggle");
  await pick(page, "Collapse");
  await expect(page.locator("[data-tool=bash] .otk-tool-toggle"))
    .toHaveAttribute("aria-expanded", "false");
  await open("[data-tool=read] .otk-tool-toggle");
  expect(await menuLabels(page)).toEqual([
    "Copy path",
    "Copy output",
    "Expand",
    "Copy reply",
    ...sessionActions,
  ]);
  await pick(page, "Copy path");
  await copied(page, "/project/source.txt");
  await open("[data-tool=edit] .otk-tool-toggle");
  expect(await menuLabels(page)).toEqual([
    "Copy path",
    "Expand",
    "Copy reply",
    ...sessionActions,
  ]);
  await pick(page, "Expand");
  await expect(page.locator("[data-tool=edit] .otk-tool-body")).toBeVisible();
  await open(".otk-diff .otk-diff-text");
  expect(await menuLabels(page)).toEqual([
    "Copy code",
    "Copy path",
    "Collapse",
    ...sessionActions,
  ]);
  await pick(page, "Copy code");
  await copied(page, "// keep\nconst newValue = 2;");
  await open(
    "[data-tool=edit] .otk-diff-content:nth-of-type(2) .otk-diff-text",
  );
  await pick(page, "Copy code");
  await copied(page, "const current = true;");
  await open("[data-tool=patch] .otk-tool-toggle");
  expect(await menuLabels(page)).toEqual([
    "Copy paths",
    "Expand",
    "Copy reply",
    ...sessionActions,
  ]);
  await pick(page, "Copy paths");
  await copied(page, "/project/main.ts\n/project/other.ts");
});
