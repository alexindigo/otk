// SPDX-License-Identifier: LGPL-3.0-only
import { expectPrimaryBlocked, send } from "../../pages/primary-action.ts";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { wire } from "../../fixtures/wire.ts";

test.describe("core capabilities", () => {
  test.use({ profile: "contract-core" });
  test("transport.core-only", {
    tag: ["@transport", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await expect(page.locator(".otk-messages")).toContainText(
      "Core transcript",
    );
    const input = page.locator("textarea[name=prompt]");
    await input.fill("Keep my draft");
    await expectPrimaryBlocked(
      send(page),
      "Sending is not supported here",
    );
    await input.press("Enter");
    await expect(page.locator(".otk-composer-refusal")).toHaveText(
      "Sending is not supported here",
    );
    await input.press("Escape");
    await input.press("Escape");
    // D65: Enter consults the same unavailable activation as the button;
    // the refusal preserves the draft and admits no native send.
    await expect(input).toHaveValue("Keep my draft");
    await input.fill("");
    await input.press("!");
    await expect(input).toHaveValue("!");
    await expect(page.locator(".otk-prompt label")).toHaveText("Prompt");
    const allowed = [
      "session.get",
      "session.messages",
      "prefs.get",
      "layout.patch",
      "layout.location",
      "frecency.list",
      "projects.visit",
      "sessions.seen",
    ];
    expect(
      frames.sent.flatMap(({ frame }) =>
        frame.t === "request" ? [frame.method] : []
      ).filter((method) => !allowed.includes(String(method))),
    ).toEqual([]);
  });
  test("transport.remove-loading-server", {
    tag: ["@transport", "@contracts", "@isolated"],
  }, async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    frames.hold((frame, request) =>
      frame.t === "index.snapshot" || frame.t === "index.patch" ||
      frame.t === "request.result" && request?.method === "session.get"
    );
    await page.addInitScript(
      (url) =>
        localStorage.setItem(
          "otk.sidecars",
          JSON.stringify([{
            id: "remote",
            baseUrl: url,
            label: "Loading server",
          }]),
        ),
      state.url,
    );
    await page.goto(`${state.url}/#/remote/tstv1-core`);
    await expect.poll(() => frames.held.length).toBeGreaterThanOrEqual(2);
    await expect.poll(() => frames.connections().opened).toBe(2);
    await expect(send(page)).toHaveCount(
      0,
    );
    await page.locator(".otk-settings-entry").click();
    await page.locator('[data-settings-sidecar="remote"] > header button')
      .click();
    await expect(page.locator('[data-settings-sidecar="remote"]')).toHaveCount(
      0,
    );
    expect(new URL(page.url()).hash).toBe("");
    await expect.poll(() => frames.connections().closed).toBe(1);
    expect(
      await page.evaluate(() =>
        JSON.parse(localStorage.getItem("otk.sidecars")!).length
      ),
    ).toBe(0);
    frames.release();
    expect(frames.held).toHaveLength(0);
    expect(new URL(page.url()).hash).toBe("");
    // Removing the selected server replaces the route and closes Settings.
    // Its delayed replies cannot reopen either Settings or the removed view.
    await expect(page.locator(".otk-settings,textarea[name=prompt]"))
      .toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Close settings", exact: true })
      .click();
    await expect(page.locator(".otk-settings,textarea[name=prompt]"))
      .toHaveCount(0);
    expect(new URL(page.url()).hash).toBe("");
  });
});

test.describe("reconnecting capabilities", () => {
  test.use({ profile: "contract-reconnect" });
  test("transport.reconnect-dirty-attention", {
    tag: ["@transport", "@contracts", "@isolated", "@attention"],
  }, async ({ isolatedState: state, page }) => {
    await page.goto(`${state.url}/#/local/tstv1-core`);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await page.locator("textarea[name=rejection]").fill(
      "Keep permission feedback",
    );
    await page.locator(".otk-question-options [data-question-row]").last()
      .click();
    await page.locator("textarea[name=question-answer]").fill(
      "Keep question answer",
    );
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "stop",
    });
    await expect(page.locator(".otk-server-status[data-connection=local]"))
      .toHaveAttribute("title", /: reconnecting;/);
    await expect(page.locator("textarea[name=rejection]")).toHaveValue(
      "Keep permission feedback",
    );
    await expectPrimaryBlocked(
      page.getByRole("button", { name: "Reject request", exact: true }),
      "Reconnect to respond",
    );
    await expect(page.locator("textarea[name=question-answer]")).toHaveValue(
      "Keep question answer",
    );
  });
});

test.describe("initial capabilities", () => {
  test.use({ profile: "contract-initial-question" });
  test("transport.initial-question", {
    tag: ["@transport", "@contracts", "@isolated", "@attention", "@readiness"],
  }, async ({ isolatedState: state, page }) => {
    const frames = await wire(page);
    for (const phase of ["direct", "reload"]) {
      frames.hold(() => true);
      if (phase === "direct") {
        await page.goto(`${state.url}/#/local/tstv1-core`);
      } else await page.reload();
      await expect(page.locator(".otk-app")).toBeVisible();
      await expect.poll(() => frames.held.length).toBeGreaterThan(0);
      await expect(
        send(page).or(page.locator(".otk-permission-dock")),
      ).toHaveCount(0);
      frames.release();
      frames.hold((frame, request) =>
        frame.t === "request.result" && request?.method === "question.list"
      );
      await expect.poll(() => frames.held.length).toBeGreaterThan(0);
      await page.locator("textarea[name=prompt]").fill("Keep initial draft");
      await expect(page.locator(".otk-question-dock")).toHaveCount(0);
      frames.release();
      await expect(page.locator(".otk-messages")).toContainText(
        "Core transcript",
      );
      await expect(page.locator(".otk-question-dock")).toBeVisible();
      await expect(page.locator(".otk-prompt")).toBeHidden();
      // The takeover's own primary replaces the hidden composer's Send.
      await expect(send(page))
        .toBeHidden();
      await expect(
        page.locator(".otk-question-dock [data-primary-action]"),
      ).toBeVisible();
      await expect(page.locator("textarea[name=prompt]")).toHaveValue(
        "Keep initial draft",
      );
      await expect(page).toHaveURL(`${state.url}/#/local/tstv1-core`);
      await page.getByRole("button", { name: "Skip question", exact: true })
        .click();
      await expect(page.locator(".otk-question-dock")).toHaveCount(0);
      await expect(page.locator(".otk-prompt")).toBeVisible();
      await expect(send(page))
        .toBeEnabled();
      expect((await state.observe<{ calls: number }>()).calls).toBe(
        phase === "direct" ? 1 : 2,
      );
      expect(
        frames.sent.filter(({ frame }) => frame.method === "question.reject")
          .at(-1)!.frame.params?.requestID,
      ).toBe("initial-question");
      await expect(page.locator("textarea[name=prompt]")).toHaveValue(
        "Keep initial draft",
      );
      await expect(page).toHaveURL(`${state.url}/#/local/tstv1-core`);
    }
  });
});
