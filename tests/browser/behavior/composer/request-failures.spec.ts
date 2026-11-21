// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

test.describe("pre-message rejection", () => {
  test.use({ profile: "composer-request-failure" });
  test("composer.failed-submit-keeps-draft-and-visible-session-record", {
    tag: ["@messages", "@composer", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Configuration rejected before send",
    });
    await openSession(state, page, session.id);
    const editor = page.locator("textarea[name=prompt]");
    await editor.fill("Keep this unsent draft intact");
    await editor.press("Enter");
    const failure = page.getByRole("region", {
      name: "Transcript",
      exact: true,
    }).locator('[data-native-record$="/request-failure"]');
    await expect(failure).toHaveCount(1);
    await expect(failure).toBeVisible();
    for (
      const text of [
        "Sending prompt failed",
        "opencode.config.ts",
        "Required",
        "Invalid",
        "HTTP 400",
      ]
    ) await expect(failure).toContainText(text);
    await expect(failure.locator(".otk-failure-target")).toHaveCount(0);
    await expect(failure).not.toContainText(
      "Configuration rejected before send",
    );
    await expect(failure.locator(".otk-failure-recovery")).toHaveCount(0);
    const notice = page.locator(".otk-operation-feedback");
    await expect(notice).toHaveText("Not sent - see the error above");
    await expect(notice).not.toContainText("opencode.config.ts");
    await expect(notice).not.toContainText("HTTP 400");
    await notice.getByRole("button", { name: "Not sent - see the error above" })
      .click();
    await expect(failure.locator("xpath=ancestor::article")).toBeFocused();
    await expect(editor).toHaveValue("Keep this unsent draft intact");
    await expect(page.locator('[data-role="user"]')).toHaveCount(0);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await info.attach(`err5-submit-${theme}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    await page.reload();
    await expect(failure).toHaveCount(1);
    await expect(failure).toContainText("opencode.config.ts");
  });
  test("composer.model-rejection-retains-native-suggestions-once", {
    tag: ["@messages", "@composer", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Rejected model with suggestions",
    });
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "fail",
    });
    await openSession(state, page, session.id);
    const editor = page.locator("textarea[name=prompt]");
    await editor.fill("Keep the model draft");
    await editor.press("Enter");
    const record = page.locator('[data-native-record$="/request-failure"]');
    await expect(record).toHaveCount(1);
    for (const text of ["x/y2", "x/y3", "HTTP 404"]) {
      await expect(record).toContainText(text);
    }
    await expect(page.locator(".otk-operation-feedback")).toHaveText(
      "Not sent - see the error above",
    );
    await expect(editor).toHaveValue("Keep the model draft");
  });
});

test.describe("native accepted failure", () => {
  test.use({ profile: "isolated" });
  test("messages.accepted-bad-model-failure-stays-with-its-turn", {
    tag: ["@messages", "@composer", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const session = await state.native<{ id: string }>("/session", "POST", {
      title: "Accepted model failure",
    });
    await wire(
      page,
      (frame) =>
        frame.t === "request" && frame.method === "session.prompt"
          ? {
            ...frame,
            params: {
              ...frame.params,
              model: { provider: "fake", model: "scripte" },
            },
          }
          : frame,
    );
    await openSession(state, page, session.id);
    const editor = page.locator("textarea[name=prompt]");
    await editor.fill("This prompt was accepted by the native");
    await editor.press("Enter");
    const transcript = page.getByRole("region", {
      name: "Transcript",
      exact: true,
    });
    const failure = transcript.locator(
      '[data-native-record$="/request-failure"]',
    );
    await expect(failure).toHaveCount(1);
    for (const row of await failure.all()) {
      await expect(row).toBeVisible();
      await expect(row).toContainText("Running session failed");
      await expect(row).toContainText("scripte");
    }
    const reasons = await failure.allTextContents();
    await expect(transcript.locator('[data-role="user"]')).toContainText(
      "This prompt was accepted by the native",
    );
    await expect(editor).toHaveValue("");
    await expect(page.locator(".otk-session-error")).toHaveCount(0);
    const promptBox = await transcript.locator('[data-role="user"]')
      .boundingBox();
    const failureBox = await failure.boundingBox();
    expect(promptBox).not.toBeNull();
    expect(failureBox).not.toBeNull();
    expect(failureBox!.y).toBeGreaterThanOrEqual(
      promptBox!.y + promptBox!.height - 1,
    );
    if (state.controller.info!.version.startsWith("1.")) {
      await expect(failure).toContainText("scripted");
      await expect(failure).toContainText("gpt-scripted");
    }
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await info.attach(`err5-accepted-${theme}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    await page.reload();
    await expect(failure).toHaveCount(1);
    await expect(failure).toHaveText(reasons);
    await expect(page.locator(".otk-session-error")).toHaveCount(0);
    for (const row of await failure.all()) await expect(row).toBeVisible();
  });
});
