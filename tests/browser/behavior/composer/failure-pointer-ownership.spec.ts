// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";

test.use({ profile: "composer-request-failure" });

test.describe("accepted send", () => {
  test.use({ profile: "isolated" });
  test("composer.revert-removes-pointer-but-keeps-the-failure", {
    tag: ["@composer", "@revert", "@isolated"],
  }, async ({ isolatedState: state, page }, info) => {
    const source = await state.native<{ id: string }>("/session", "POST", {
      title: "Revert past a failed send",
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
    await openSession(state, page, source.id);
    const input = page.locator("textarea[name=prompt]");
    await input.fill("Revert from this failed prompt");
    await input.press("Enter");
    const notice = page.locator(".otk-composer-notice");
    const record = page.locator('[data-native-record$="/request-failure"]');
    await expect(record).toHaveCount(1);
    await expect(notice.locator(".otk-failure-reference")).toHaveCount(1);

    // 1.19.3 leaves the native run busy after the invalid-model error. End
    // that run without the composer Stop action withdrawing the test prompt.
    if (info.project.name === "oc-1.19.3") {
      await state.product("session.abort", { sessionID: source.id });
      await expect(page.locator(`[data-session="${source.id}"]`))
        .toHaveAttribute("data-status", "idle");
    }

    const prompt = page.getByText("Revert from this failed prompt", {
      exact: true,
    });
    await prompt.scrollIntoViewIfNeeded();
    const bubble = prompt.locator("xpath=ancestor::article");
    await bubble.locator(".otk-user-bubble").focus();
    await bubble.locator('[data-message-command="prompt.revert"]').click();
    await page.getByRole("button", { name: "Confirm revert", exact: true })
      .click();
    await expect(page.locator(".otk-revert-group")).toContainText(
      "Reverted from",
    );
    await expect(record).toHaveCount(0);
    await expect(notice.locator(".otk-failure-reference")).toHaveCount(0);
    await expect(notice.locator(".otk-failure-heading")).toHaveText(
      "Running session failed",
    );
    await expect(page.getByText("Running session failed", { exact: true }))
      .toHaveCount(1);
    await info.attach("reverted-failure-without-pointer", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
  });
});

test("messages.definitive-independent-rejection-has-one-session-pointer", {
  tag: ["@messages", "@composer", "@isolated"],
}, async ({ isolatedState: state, page }, info) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Independent rejection",
  });
  await openSession(state, page, source.id);
  let rejected = false;
  try {
    await state.product("session.prompt", {
      sessionID: source.id,
      mode: "normal",
      parts: [{ kind: "text", text: "Independent rejected input" }],
    });
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
  const record = page.locator('[data-native-record$="/request-failure"]');
  await expect(record).toHaveCount(1);
  await expect(record).toContainText("opencode.config.ts");
  const pointer = page.locator(".otk-session-error");
  await expect(pointer).toHaveCount(1);
  await expect(pointer).toHaveText("See the session error");
  await expect(page.locator(".otk-operation-feedback")).toHaveCount(0);
  await expect(pointer).not.toContainText("opencode.config.ts");
  await info.attach("independent-rejection-session-pointer", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
  await pointer.getByRole("button", {
    name: "See the session error",
    exact: true,
  }).click();
  await expect(record.locator("xpath=ancestor::article")).toBeFocused();
});

test(
  "messages.another-client-composer-pointer-is-rendered-before-it-owns-the-view",
  {
    tag: ["@messages", "@composer", "@isolated"],
  },
  async ({ isolatedState: state, page, browser }, info) => {
    const source = await state.native<{ id: string }>("/session", "POST", {
      title: "Another client's rejected submission",
    });
    await openSession(state, page, source.id);
    const remote = await (await state.newContext(browser)).newPage();
    await openSession(state, remote, source.id);
    const input = remote.locator("textarea[name=prompt]");
    await input.fill("Keep this other client's exact draft");
    await input.press("Enter");
    const record = page.locator('[data-native-record$="/request-failure"]');
    await expect(record).toHaveCount(1);
    await expect(record).toContainText("opencode.config.ts");
    await expect(input).toHaveValue("Keep this other client's exact draft");
    const pointer = page.locator(".otk-operation-feedback");
    await expect(pointer).toHaveCount(1);
    await expect(pointer.locator(".otk-record-row-label")).toHaveText(
      "Not sent. Sending prompt failed",
    );
    await expect(page.locator(".otk-session-error")).toHaveCount(0);
    await info.attach("remote-composer-displayed-pointer", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await pointer.getByRole("button", {
      name: "Show error",
      exact: true,
    }).click();
    await expect(record.locator("xpath=ancestor::article")).toBeFocused();
    await page.reload();
    await expect(record).toHaveCount(1);
    await expect(pointer.locator(".otk-record-row-label")).toHaveText(
      "Not sent. Sending prompt failed",
    );
    await expect(pointer.getByRole("button", { name: "Show error" }))
      .toBeVisible();
    await expect(page.locator(".otk-session-error")).toHaveCount(0);
  },
);
