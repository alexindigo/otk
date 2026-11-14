// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { focusNotifications } from "../../pages/notifications.ts";

test.use({ profile: "isolated" });
test("attention.native-failure-toast-identifies-the-background-session", {
  tag: ["@attention", "@transport", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await state.product("prefs.set", { key: "notify.os", value: false });
  await state.product("prefs.set", { key: "notify.sound", value: false });
  const failed = await state.native<{ id: string }>("/session", "POST", {
    title: "Background failure fixture",
  });
  await openSession(state, page, failed.id);
  const other = await state.native<{ id: string }>("/session", "POST", {
    title: "Current conversation",
  });
  await openSession(state, page, other.id);
  await focusNotifications(page);
  if (info.project.name === "oc-2.2.6") {
    await state.native(`/session/${failed.id}/prompt_async`, "POST", {
      parts: [{ type: "text", text: "Fail before producing a message" }],
      agent: "missing-failure-fixture-agent",
    });
  } else {
    await expect(state.native(`/session/${failed.id}/shell`, "POST", {
      command: "echo should-not-run",
      agent: "missing-failure-fixture-agent",
    })).rejects.toThrow("500");
  }
  const toast = page.locator('.otk-toast[data-kind="error"]').filter({
    hasText: "Running session failed",
  });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText("Running session failed");
  await expect(toast).toContainText("missing-failure-fixture-agent");
  await expect(
    toast.getByRole("link", {
      name: "Background failure fixture",
      exact: true,
    }),
  ).toHaveAttribute("href", `#/local/${failed.id}`);
  await expect(toast).toContainText("OTK will not repeat this action");
  await expect(page.locator('.otk-toast[data-kind="done"]')).toHaveCount(0);
  if (info.project.name === "oc-2.2.6") {
    await expect(
      page.locator('.otk-toast[data-kind="error"]').filter({
        has: page.getByText("Session failed", { exact: true }),
      }),
    ).toHaveCount(1);
  }
  // A failed native execution can also produce a legitimate unseen finish.
  // It must not invent pending user input; error-only badge isolation is covered
  // by the request-burst and controlled-notification consumer proofs.
  await expect(page.getByRole("img", { name: "Needs you", exact: true }))
    .toHaveCount(0);
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await info.attach(`failure-toast-native-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
});
