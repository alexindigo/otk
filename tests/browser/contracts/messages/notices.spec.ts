// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
test.use({ profile: "contract-messages-v1-notices" });
test("messages.v1-context-expansions-task-failure-and-summary", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openSession(state, page, "tstv1-otk");
  const standalone = page.locator('[data-message="context"]');
  await expect(standalone).toHaveAttribute("data-role", "context");
  await expect(standalone.locator(".otk-user-bubble")).toHaveCount(0);
  await expect(standalone.getByRole("button", { name: "Outgoing context" }))
    .toHaveAttribute("aria-expanded", "false");
  const prompt = page.locator('[data-message="prompt"]');
  await expect(prompt).toHaveAttribute("data-role", "user");
  await expect(prompt.locator(".otk-user-bubble")).toContainText(
    "Please investigate",
  );
  await expect(prompt.getByRole("button", { name: "Outgoing context" }))
    .toHaveAttribute("aria-expanded", "false");
  await prompt.getByRole("button", { name: "Outgoing context" }).click();
  await expect(prompt.locator("strong")).toHaveText("Attached context");
  await expect(prompt.locator("footer")).toHaveCount(1);
  const failed = page.locator('[data-message="task-notice"]');
  await expect(failed.locator(".otk-native-record")).toHaveClass(/is-error/);
  await failed.getByRole("button", { name: /Task failed/ }).click();
  await expect(failed.locator(".otk-tool-body")).toContainText(
    "The usage limit has been reached",
  );
  await expect(page.locator('[data-message="reply"] [role="alert"]'))
    .toHaveText("The usage limit has been reached");
  await expect(page.locator('[data-message="summary"]')).toHaveAttribute(
    "data-role",
    "context",
  );
  await expect(page.locator('[data-message="permission:retained"]'))
    .toContainText("Permission rejected");
  await expect(page.locator('[data-message="question:retained"]'))
    .toContainText("Question cancelled");
  const permission = page.locator('[data-message="permission:retained"]');
  const question = page.locator('[data-message="question:retained"]');
  await expect(permission.locator(".otk-tool-brief")).toHaveText(
    "bash: git status --short",
  );
  await expect(question.locator(".otk-tool-brief")).toHaveText(
    "Verification: Run the focused checks?",
  );
  const retry = page.locator('[data-message="retry:retained"]');
  await expect(retry).toContainText("Free usage exceeded");
  await retry.getByRole("button", { name: /Retry 1/ }).click();
  await expect(retry.getByRole("link", { name: "subscribe" })).toHaveAttribute(
    "href",
    "https://opencode.ai/go",
  );
  await expect(
    retry.locator(".otk-tool-body > p").filter({ hasText: /^Retry 1$/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(standalone).toHaveAttribute("data-role", "context");
  await expect(prompt.locator(".otk-user-bubble")).toContainText(
    "Please investigate",
  );
});

test("messages.request-source-defaults-and-explicit-choices", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page }) => {
  await openSession(state, page, "tstv1-otk");
  const permission = page.locator('[data-message="permission:retained"]');
  const question = page.locator('[data-message="question:retained"]');
  for (
    const [row, title] of [[permission, /Permission rejected/], [
      question,
      /Question cancelled/,
    ]] as const
  ) {
    await row.getByRole("button", { name: title }).click();
    await expect(row.getByRole("button", { name: "Source", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await expect(row.locator(".otk-native-preview")).toHaveCount(0);
  }
  const permissionSource = permission.getByRole("button", {
    name: "Source",
    exact: true,
  });
  const questionSource = question.getByRole("button", {
    name: "Source",
    exact: true,
  });
  await permissionSource.click();
  await expect(permission.locator(".otk-native-preview")).toContainText(
    '"permission":"bash"',
  );
  await expect(question.locator(".otk-native-preview")).toHaveCount(0);
  await state.product("prefs.set", { key: "expandSource", value: true });
  await expect(questionSource).toHaveAttribute("aria-expanded", "true");
  await permissionSource.click();
  await state.product("prefs.set", { key: "expandSource", value: false });
  await state.product("prefs.set", { key: "expandSource", value: true });
  await expect(permissionSource).toHaveAttribute("aria-expanded", "false");
  await expect(permission.locator(".otk-native-preview")).toHaveCount(0);
  await permission.getByRole("button", { name: /Permission rejected/ }).click();
  await permission.getByRole("button", { name: /Permission rejected/ }).click();
  await expect(permissionSource).toHaveAttribute("aria-expanded", "false");
  await expect(questionSource).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  for (
    const [row, title] of [[permission, /Permission rejected/], [
      question,
      /Question cancelled/,
    ]] as const
  ) {
    await row.getByRole("button", { name: title }).click();
    await expect(row.getByRole("button", { name: "Source", exact: true }))
      .toHaveAttribute("aria-expanded", "true");
    await expect(row.locator(".otk-native-preview")).toHaveCount(1);
  }
  await state.product("prefs.set", { key: "expandSource", value: false });
  await expect(permission.locator(".otk-native-preview")).toHaveCount(0);
  await expect(question.locator(".otk-native-preview")).toHaveCount(0);
});
