// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession, wire } from "../../fixtures/wire.ts";
import {
  prompt,
  revealAcquired,
  scrollTranscript,
} from "../../pages/transcript.ts";
import { messages } from "../../pages/composer.ts";
import { pick, rightClick } from "../../pages/menus.ts";

test.use({
  profile: "revert-native",
  viewport: { width: 1280, height: 800 },
  timezoneId: "America/Los_Angeles",
});
const themes = [["dark", "otk-dark"], ["linen", "otk-light"], [
  "stone",
  "otk-light-stone",
]];
test("revert.identity-confirmation-preservation-and-in-flow-geometry", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  test.setTimeout(240_000);
  const frames = await wire(page);
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "Revert by identity",
  });
  await state.product("prefs.set", { key: "animationsOff", value: true });
  await openSession(state, page, source.id);
  for (
    const text of [
      "First prompt kept live",
      "Boundary prompt restored to the composer",
      "Last prompt in the earlier branch",
    ]
  ) {
    await state.queue([
      "Full reply to " + text +
      ".\n\nThe complete earlier record stays readable after reverting.",
    ]);
    await prompt(page, text);
    await expect(page.locator(".otk-messages")).toContainText(
      "Full reply to " + text,
    );
    await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
      "data-status",
      "idle",
    );
  }
  const original = await messages(state, source.id);
  const boundary = original.find((m) =>
    m.info.role === "user" &&
    m.parts.some((p: { text?: string }) =>
      p.text?.startsWith("Boundary prompt")
    )
  )!;
  const input = page.locator("textarea[name=prompt]");
  await input.fill("Prior unsent draft is preserved");
  const request = async (messageID = boundary.info.id) => {
    await revealAcquired(
      page,
      `[data-message="${messageID}"] .otk-user-bubble`,
    );
    const bubble = page.locator(
      `[data-message="${messageID}"] .otk-user-bubble`,
    );
    await bubble.scrollIntoViewIfNeeded();
    await bubble.focus();
    await bubble.locator("..").locator('[data-message-command="prompt.revert"]')
      .click();
    await expect(
      page.getByRole("region", { name: "Confirm revert", exact: true }),
    ).toBeVisible();
  };
  const geometry = async (dismissed = false) => {
    const measured = await page.evaluate(() => {
      const pane = document.querySelector(".otk-messages")!
        .getBoundingClientRect();
      const dock = document.querySelector(".otk-composer-dock")!
        .getBoundingClientRect();
      const group = document.querySelector(".otk-revert-group") as
        | HTMLElement
        | null;
      const header = group?.querySelector(".otk-record-group-heading");
      const labels = Array.from(
        document.querySelectorAll(".otk-revert-group .otk-control-label"),
      );
      return {
        gap: dock.top - pane.bottom,
        position: group && getComputedStyle(group).position,
        groupHeight: group?.getBoundingClientRect().height,
        headerHeight: header?.getBoundingClientRect().height,
        labels: labels.map((el) => ({
          height: el.getBoundingClientRect().height,
          line: parseFloat(getComputedStyle(el).lineHeight),
        })),
      };
    });
    expect(measured.gap).toBeGreaterThanOrEqual(-1);
    expect(measured.position).not.toBe("absolute");
    if (dismissed) {
      expect(measured.groupHeight! - measured.headerHeight!)
        .toBeLessThanOrEqual(1);
    }
    for (const label of measured.labels) {
      if (Number.isFinite(label.line)) {
        expect(label.height).toBeLessThanOrEqual(label.line + 2);
      }
    }
  };
  const capture = async (name: string, dismissed = false) => {
    if (name === "confirming") {
      await page.getByRole("region", { name: "Confirm revert", exact: true })
        .scrollIntoViewIfNeeded();
    }
    if (name === "saved-expanded") {
      await scrollTranscript(page, false);
      await page.locator(".otk-revert-group .otk-record-group-heading")
        .scrollIntoViewIfNeeded();
    }
    for (const [theme, id] of themes) {
      await state.product("prefs.set", { key: "theme", value: id });
      await expect(page.locator("html")).toHaveAttribute("data-otk-theme", id);
      await page.evaluate(() => document.fonts.ready);
      await geometry(dismissed);
      await page.mouse.move(1270, 790);
      await page.screenshot({
        path: test.info().outputPath(`revert-${name}-${theme}.png`),
        animations: "disabled",
      });
    }
  };
  await request();
  await expect(
    page.getByRole("region", { name: "Confirm revert", exact: true }),
  ).toContainText("Last prompt in the earlier branch");
  expect(frames.sent.filter(({ frame }) => frame.method === "session.revert"))
    .toHaveLength(0);
  await capture("confirming");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(frames.sent.filter(({ frame }) => frame.method === "session.revert"))
    .toHaveLength(0);
  await expect(input).toHaveValue("Prior unsent draft is preserved");
  await request();
  frames.hold((frame, request) =>
    frame.t === "request.result" && request?.method === "session.revert"
  );
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(page.locator(".otk-revert-group")).toContainText("Reverting");
  await capture("staging");
  frames.release();
  frames.hold((frame, request) =>
    frame.t === "request.result" && request?.method === "history.messages"
  );
  await expect(page.locator(".otk-revert-group")).toContainText("Saving copy");
  await expect(input).toHaveValue("Boundary prompt restored to the composer");
  await capture("saving");
  frames.release();
  await expect(page.locator(".otk-revert-group")).toContainText("Copy saved");
  await capture("saved");
  await page.locator(".otk-revert-group .otk-record-group-toggle").click();
  await scrollTranscript(page, true);
  await expect(page.locator(".otk-revert-records")).toContainText(
    "Full reply to Last prompt in the earlier branch",
  );
  await expect(page.locator(".otk-revert-records")).not.toContainText(
    "First prompt kept live",
  );
  await capture("saved-expanded");
  await page.getByRole("button", { name: "Dismiss revert", exact: true })
    .click();
  await expect(page.locator(".otk-revert-records")).toHaveCount(0);
  await capture("dismissed", true);
  await page.reload();
  await expect(page.locator(".otk-revert-group")).toHaveAttribute(
    "data-dismissed",
    "true",
  );
  await rightClick(page, ".otk-revert-group");
  await pick(page, "Restore conversation");
  await expect(page.locator(".otk-revert-group")).toHaveCount(0);
  await expect(page.locator(".otk-messages")).toContainText(
    "Last prompt in the earlier branch",
  );
  await capture("restored");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Reflect.set(globalThis, "restoreRevertStorage", () => {
      Storage.prototype.setItem = original;
    });
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("otk.branch-history")) {
        throw new DOMException("full", "QuotaExceededError");
      }
      original.call(this, key, value);
    };
  });
  const failedBoundary = original.find((m) =>
    m.info.role === "user" &&
    m.parts.some((p) => p.text?.startsWith("First prompt"))
  )!;
  await request(failedBoundary.info.id);
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(page.locator(".otk-revert-group")).toContainText("Retry");
  await expect(input).toHaveValue("First prompt kept live");
  await capture("failed");
  await input.fill("Replacement after a saved copy");
  await input.press("Enter");
  const choice = page.locator(".otk-permanence-choice");
  await expect(choice).toContainText("Sending makes the revert permanent");
  await expect(choice.locator(".otk-failure-heading strong")).toHaveText(
    "Sending makes the revert permanent",
  );
  await expect(input).toHaveValue("Replacement after a saved copy");
  await capture("failed-send");
  await choice.getByRole("button", { name: "Save copy", exact: true }).click();
  await expect(choice).toContainText("localStorage is full");
  await expect(choice.getByRole("button", { name: "Save copy", exact: true }))
    .toBeEnabled();
  await expect(input).toHaveValue("Replacement after a saved copy");
  await page.evaluate(() => Reflect.get(globalThis, "restoreRevertStorage")());
  await state.queue(["Replacement with a durable copy accepted."]);
  await choice.getByRole("button", { name: "Save copy", exact: true }).click();
  await expect(page.locator(".otk-messages")).toContainText(
    "Replacement with a durable copy accepted.",
  );
  await expect(page.locator(".otk-revert-group")).toHaveCount(0);
  const replacement = (await messages(state, source.id)).find((m) =>
    m.parts.some((p) => p.text === "Replacement after a saved copy")
  )!;
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("otk.branch-history")) {
        throw new DOMException("full", "QuotaExceededError");
      }
      original.call(this, key, value);
    };
  });
  await request(replacement.info.id);
  await page.getByRole("button", { name: "Confirm revert", exact: true })
    .click();
  await expect(page.locator(".otk-revert-group")).toContainText("Retry");
  await input.fill("Explicit replacement without a copy");
  await input.press("Enter");
  await expect(choice).toContainText("Sending makes the revert permanent");
  await state.queue(["Explicit replacement accepted."]);
  await choice.getByRole("button", { name: "Send anyway", exact: true })
    .click();
  await expect(page.locator(".otk-messages")).toContainText(
    "Explicit replacement accepted.",
  );
  await expect(page.locator(".otk-revert-group")).toHaveCount(0);
  expect(
    (await messages(state, source.id)).some((m) =>
      m.info.id === replacement.info.id
    ),
  ).toBe(false);
});

test("revert.external-stage-dismissal-and-native-commit-retirement", {
  tag: ["@revert", "@isolated"],
}, async ({ isolatedState: state, page }) => {
  const source = await state.native<{ id: string }>("/session", "POST", {
    title: "External revert",
  });
  await openSession(state, page, source.id);
  await state.queue(["External reply remains readable."]);
  await prompt(page, "Prompt staged by another client");
  await expect(page.locator(".otk-messages")).toContainText(
    "External reply remains readable.",
  );
  await expect(page.locator(`[data-session="${source.id}"]`)).toHaveAttribute(
    "data-status",
    "idle",
  );
  const boundary = (await messages(state, source.id)).find((m) =>
    m.info.role === "user"
  )!;
  await state.native(`/session/${source.id}/revert`, "POST", {
    messageID: boundary.info.id,
    files: false,
  });
  await expect(page.locator(".otk-revert-group")).toContainText(
    "Prompt staged by another client",
  );
  await page.getByRole("button", { name: "Dismiss revert", exact: true })
    .click();
  await page.reload();
  await expect(page.locator(".otk-revert-group")).toHaveAttribute(
    "data-dismissed",
    "true",
  );
  await state.queue(["Another client committed the native stage."]);
  await state.product("session.prompt", {
    sessionID: source.id,
    mode: "normal",
    parts: [{ kind: "text", text: "External replacement" }],
  });
  await expect(page.locator(".otk-revert-group")).toHaveCount(0);
  await expect(page.locator(".otk-messages")).toContainText(
    "Another client committed the native stage.",
  );
});
