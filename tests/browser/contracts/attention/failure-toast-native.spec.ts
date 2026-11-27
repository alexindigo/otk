// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { focusNotifications } from "../../pages/notifications.ts";
import { sessionContext } from "../../pages/sessions.ts";

test.use({ profile: "isolated" });
test("attention.native-failure-toast-identifies-the-background-session", {
  tag: ["@attention", "@transport", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  await state.product("prefs.set", { key: "notify.os", value: false });
  await state.product("prefs.set", { key: "notify.sound", value: false });
  const failed = await state.native<{ id: string }>("/session", "POST", {
    title: "Background failure fixture",
  });
  const other = await state.native<{ id: string }>("/session", "POST", {
    title: "Current conversation",
  });
  // Seed both rows before the first directory acquisition and wait for its
  // actual publication before selecting the second conversation.
  await openSession(state, page, failed.id);
  await expect(page.locator(`[data-session="${other.id}"]`)).toBeVisible();
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
  // Running-session notifications supply their own inspection step; the native
  // reason and that owner-authored step remain separate facts.
  await expect(toast.locator(".otk-failure-recovery")).toHaveText(
    "Open the session to inspect the provider response before sending a new prompt.",
  );
  await expect(page.locator('.otk-toast[data-kind="done"]')).toHaveCount(0);
  await expect(page.locator('.otk-toast[data-kind="error"]')).toHaveCount(1);
  // V1 rejects this shell before admitting a run. Its diagnostic is not a
  // terminal fact; keep proving error-only badge isolation on that path.
  if (info.project.name === "oc-1.19.3") {
    await expect(page.getByRole("img", { name: "Needs you", exact: true }))
      .toHaveCount(0);
  }
  // 2.72: an unseen failed run needs acknowledgement, not a yellow successful
  // finish. The session owner and every rollup publish that same fact.
  const project = page.locator(
    `.otk-project-row[data-project=${
      JSON.stringify(state.directory)
    }] .otk-status-light`,
  );
  const session = page.locator(
    `.otk-project-sessions [data-session=${
      JSON.stringify(failed.id)
    }] .otk-status-light`,
  );
  const tab = page.locator(`[data-tab=${JSON.stringify(failed.id)}]`);
  if (info.project.name === "oc-2.2.6") {
    await expect(project).toHaveAttribute("data-state", "blocked");
    await expect(session).toHaveAttribute("data-state", "blocked");
    await expect(tab.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "blocked",
    );
    const published = (await state.product("inbox.get", {})).inbox;
    expect(published.entities?.["global:global"]?.counts.blocked).toBe(1);
    for (
      const key of [
        `checkout:${state.directory}`,
        `project:${state.directory}`,
        "global:global",
      ]
    ) {
      expect(published.entities?.[key]?.state, key).toBe("blocked");
    }
  }
  for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
    await state.product("prefs.set", { key: "theme", value: theme });
    await expect(page.locator("html")).toHaveAttribute("data-otk-theme", theme);
    await info.attach(`failure-toast-native-${theme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  }
  // A real visit acknowledges the terminal the browser actually received.
  if (info.project.name === "oc-2.2.6") {
    await openSession(state, page, failed.id);
    await openSession(state, page, other.id);
    await expect(project).toHaveAttribute("data-state", "none");
    await expect(session).toHaveAttribute("data-state", "none");
    // D76: acknowledgement retires the failed attention, not the explicit open.
    await expect(tab.locator(".otk-status-light")).toHaveAttribute(
      "data-state",
      "none",
    );
    await sessionContext(page, `[data-tab="${failed.id}"]`, "session.close");
    await expect(tab).toHaveCount(0);
  }
});
