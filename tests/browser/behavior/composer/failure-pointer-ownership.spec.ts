// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";

test.use({ profile: "composer-request-failure" });
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
    await expect(pointer).toHaveText("Not sent - see the error above");
    await expect(page.locator(".otk-session-error")).toHaveCount(0);
    await info.attach("remote-composer-displayed-pointer", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await pointer.getByRole("button", {
      name: "Not sent - see the error above",
      exact: true,
    }).click();
    await expect(record.locator("xpath=ancestor::article")).toBeFocused();
    await page.reload();
    await expect(record).toHaveCount(1);
    await expect(pointer).toHaveText("Not sent - see the error above");
    await expect(page.locator(".otk-session-error")).toHaveCount(0);
  },
);
