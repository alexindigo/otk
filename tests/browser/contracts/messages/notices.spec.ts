// SPDX-License-Identifier: LGPL-3.0-only
import { openLatestWork } from "../../pages/transcript.ts";
import { expect } from "../../fixtures/evidence.ts";
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { openSession } from "../../fixtures/wire.ts";
import { revealAcquired } from "../../pages/transcript.ts";
test.describe("V1 records", () => {
  test.use({ profile: "contract-messages-v1-notices" });
  test("messages.running-record-progress-survives-queued-prompt", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openSession(state, page, "tstv1-atmosphera");
    await expect(
      page.locator('[data-message="queued-prompt"] .otk-user-bubble'),
    ).toHaveText("Queued next prompt");
    const progress = page.locator(
      '[data-message="running-record"] .otk-response-progress',
    );
    await expect(progress).toBeVisible();
    await expect(page.locator(".otk-response-progress")).toHaveCount(1);
    await page.reload();
    await expect(progress).toBeVisible();
    const screenshot = info.outputPath("running-record-progress.png");
    await page.screenshot({ path: screenshot });
    await info.attach("running-record-progress", {
      path: screenshot,
      contentType: "image/png",
    });
    await state.controller.call("scenario", {
      lease: state.lease.lease,
      action: "release",
    });
    await expect(page.locator(".otk-response-progress")).toHaveCount(0);
    await page.reload();
    // Settled records rejoin the interval; inspect through its reveal owner.
    await revealAcquired(page, '[data-message="running-record"]');
    await expect(page.locator('[data-message="running-record"]')).toContainText(
      "Native work finished",
    );
    await expect(page.locator(".otk-response-progress")).toHaveCount(0);
    await expect(
      page.locator('[data-message="queued-prompt"] .otk-user-bubble'),
    ).toHaveText("Queued next prompt");
  });
  test("messages.v1-context-expansions-task-failure-and-summary", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await openSession(state, page, "tstv1-otk");
    // Eligible singleton records retain the same public span/fold hierarchy.
    const openRecords = async () => {
      const closed = page.locator(
        '.otk-record-group-toggle[aria-expanded="false"]',
      );
      while (await closed.count()) await closed.first().click();
    };
    await openRecords();
    await revealAcquired(page, '[data-message="context"]');
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
    await expect(failed.locator(".otk-failure-reason")).toHaveText(
      "The usage limit has been reached",
    );
    const reply = page.locator('[data-message="reply"]');
    await expect(reply.getByRole("alert")).toHaveCount(2);
    for (
      const name of [
        "Delegate failed: Subagent failed: The usage limit has been reached.",
        "Running session failed: The usage limit has been reached.",
      ]
    ) {
      await expect(
        reply.getByRole("alert", { name, exact: true })
          .locator(".otk-failure-main-reason .otk-failure-reason"),
      ).toContainText("The usage limit has been reached");
    }
    await revealAcquired(page, '[data-message="summary"]');
    await expect(page.locator('[data-message="summary"]')).toHaveAttribute(
      "data-role",
      "context",
    );
    await revealAcquired(page, '[data-message="permission:retained"]');
    await expect(page.locator('[data-message="permission:retained"]'))
      .toContainText("Permission rejected");
    await revealAcquired(page, '[data-message="question:retained"]');
    await expect(page.locator('[data-message="question:retained"]'))
      .toContainText("Question cancelled");
    const permission = page.locator('[data-message="permission:retained"]');
    const question = page.locator('[data-message="question:retained"]');
    await expect(
      permission.locator(".otk-failure-main-reason .otk-failure-reason"),
    ).toHaveText(
      "bash: git status --short",
    );
    await expect(
      question.locator(".otk-failure-main-reason .otk-failure-reason"),
    ).toHaveText(
      "Verification: Run the focused checks?",
    );
    const retry = page.locator('[data-message="retry:retained"]');
    await revealAcquired(page, '[data-message="retry:retained"]');
    await expect(retry).toContainText("Free usage exceeded");
    await retry.getByRole("button", { name: /Retry 1/ }).click();
    await expect(retry.getByRole("link", { name: "subscribe" }))
      .toHaveAttribute(
        "href",
        "https://opencode.ai/go",
      );
    await expect(
      retry.locator(".otk-tool-body > p").filter({ hasText: /^Retry 1$/ }),
    ).toHaveCount(0);
    await page.reload();
    await openRecords();
    await revealAcquired(page, '[data-message="context"]');
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
      const [id, title] of [["permission:retained", /Permission rejected/], [
        "question:retained",
        /Question cancelled/,
      ]] as const
    ) {
      const selector = `[data-message="${id}"]`;
      await revealAcquired(page, selector);
      const row = page.locator(selector);
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
    await permission.getByRole("button", { name: /Permission rejected/ })
      .click();
    await permission.getByRole("button", { name: /Permission rejected/ })
      .click();
    await expect(permissionSource).toHaveAttribute("aria-expanded", "false");
    await expect(questionSource).toHaveAttribute("aria-expanded", "true");
    await page.reload();
    for (
      const [id, title] of [["permission:retained", /Permission rejected/], [
        "question:retained",
        /Question cancelled/,
      ]] as const
    ) {
      const selector = `[data-message="${id}"]`;
      await revealAcquired(page, selector);
      const row = page.locator(selector);
      await row.getByRole("button", { name: title }).click();
      await expect(row.getByRole("button", { name: "Source", exact: true }))
        .toHaveAttribute("aria-expanded", "true");
      await expect(row.locator(".otk-native-preview")).toHaveCount(1);
    }
    await state.product("prefs.set", { key: "expandSource", value: false });
    await expect(permission.locator(".otk-native-preview")).toHaveCount(0);
    await expect(question.locator(".otk-native-preview")).toHaveCount(0);
  });
});
test.describe("V2 records", () => {
  test.use({ profile: "contract-messages-notices" });
  test("messages.v2-boundaries-idle-error-and-distinct-retry-records", {
    tag: ["@messages", "@contracts"],
  }, async ({ isolatedState: state, page }, info) => {
    await page.setViewportSize({ width: 1280, height: 1600 });
    await openSession(state, page, "tstv1-otk");
    const idle = page.locator('[data-native-record="opencode-v2/idle"]');
    await expect(idle).toHaveClass(/is-error/);
    await expect(idle).toContainText("The usage limit has been reached");
    await revealAcquired(
      page,
      '[data-native-record="opencode-v2/model-switched"]',
    );
    await expect(
      page.locator('[data-native-record="opencode-v2/model-switched"]'),
    ).toContainText("Switched variant to high");
    await expect(
      page.locator('[data-native-record="opencode-v2/location-switched"]'),
    ).toContainText("Moved to /project/destination");
    const compaction = page.locator(
      '[data-native-record="opencode-v2/compaction"]',
    );
    await expect(compaction).toContainText(
      "Session compacted - 439.7K in - 2.9K out",
    );
    await compaction.locator(".otk-tool-toggle").click();
    await expect(compaction.locator("strong")).toHaveText("Compaction summary");
    await expect(page.locator('[data-native-record="opencode-v2/retry"]'))
      .toContainText("Retry scheduled - attempt 2");
    await openLatestWork(page);
    await expect(
      page.locator('[data-native-record="opencode-v2/active-retry"]'),
    ).toContainText("Provider temporarily unavailable");
    await expect(page.locator(".otk-response-progress")).toHaveCount(1);
    for (const theme of ["otk-dark", "otk-light", "otk-light-stone"]) {
      await state.product("prefs.set", { key: "theme", value: theme });
      await expect(page.locator("html")).toHaveAttribute(
        "data-otk-theme",
        theme,
      );
      await info.attach(`nt3-records-${theme}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
    await page.reload();
    await expect(idle).toContainText("The usage limit has been reached");
  });
  test(
    "messages.v2-notices-preserve-separate-errors-rendered-results-and-request-outcomes",
    { tag: ["@messages", "@contracts"] },
    async ({ isolatedState: state, page }) => {
      await page.setViewportSize({ width: 1280, height: 1600 });
      await openSession(state, page, "tstv1-otk");
      const system = page.locator('[data-native-record="opencode-v2/system"]');
      await revealAcquired(page, '[data-native-record="opencode-v2/system"]');
      await expect(system).toContainText("System");
      await expect(system).toContainText("Instructions updated: codemode");
      const failed = page.locator(
        '[data-native-record="opencode-v2/synthetic"]',
      )
        .filter({
          has: page.locator(".otk-entity-pill", { hasText: "Junior" }),
        })
        .filter({ has: page.getByText("failed", { exact: true }) });
      await expect(
        failed.getByRole("button", {
          name: "Junior details",
          exact: true,
        }),
      ).toHaveText("Junior");
      await expect(failed.getByText("failed", { exact: true })).toBeVisible();
      await expect(failed).toHaveClass(/is-error/);
      await expect(failed.getByRole("img", { name: "Failed" })).toBeVisible();
      await expect(
        failed.getByRole("button", {
          name: "Open task details",
          exact: true,
        }),
      )
        .toBeVisible();
      await failed.locator(".otk-tool-toggle").click();
      await expect(failed.getByRole("img", { name: "Failed" }).locator("svg"))
        .toHaveCSS("transform", "none");
      await expect(failed).toContainText("The usage limit has been reached");
      // Native source is the shared nested Source fold, closed by default.
      const source = failed.locator(".otk-native-source");
      await expect(source).toHaveCount(1);
      await expect(source.locator(".otk-tool-toggle")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
      await expect(failed.locator(".otk-native-preview")).toHaveCount(0);
      // The state is presented once, by its parameter row.
      await expect(failed.locator(".otk-native-parameters")).toContainText(
        "State",
      );
      await expect(
        failed.locator(".otk-tool-body > p").filter({ hasText: /^error$/ }),
      ).toHaveCount(0);
      // Plain and navigable values share one column edge and baseline offset.
      const rows = await failed.locator(".otk-native-parameters").evaluate((
        list,
      ) =>
        Array.from(list.querySelectorAll(":scope > dt")).map((dt) => {
          const label = dt.getBoundingClientRect(),
            value = dt.nextElementSibling!.querySelector(
              ".otk-native-value, .otk-entity-pill",
            )!
              .getBoundingClientRect();
          return {
            left: value.left,
            offset: (value.top + value.bottom - label.top - label.bottom) / 2,
            child: !!dt.nextElementSibling!.querySelector("button"),
          };
        })
      );
      expect(rows.some((row) => row.child)).toBe(true);
      expect(
        Math.max(...rows.map((r) => r.left)) -
          Math.min(...rows.map((r) => r.left)),
      )
        .toBeLessThanOrEqual(0.5);
      expect(
        Math.max(...rows.map((r) => r.offset)) -
          Math.min(...rows.map((r) => r.offset)),
      ).toBeLessThanOrEqual(1);
      await source.locator(".otk-tool-toggle").click();
      await expect(source.locator(".otk-native-preview")).toBeVisible();
      await expect(source).toContainText("bytes");
      await expect(
        page.locator(".otk-message").getByRole("alert", {
          name: "Running session failed: The usage limit has been reached.",
          exact: true,
        }).locator(".otk-failure-main-reason .otk-failure-reason"),
      ).toHaveText("The usage limit has been reached");
      await expect(page.locator('[data-native-record="opencode-v2/shell"]'))
        .toContainText("Exited with code 7");
      await revealAcquired(
        page,
        '[data-native-record="opencode-v2/request-outcome"]',
      );
      await expect(
        page.locator('[data-native-record="opencode-v2/request-outcome"]'),
      ).toContainText("Question cancelled");
      await openLatestWork(page);
      const task = page.locator('[data-tool="task"]');
      await task.locator(".otk-tool-toggle").first().click();
      await expect(task.locator("strong.otk-prose-strong")).toHaveText(
        "Result",
      );
      await expect(task.locator("table")).toHaveCount(1);
      await expect(task.locator(".otk-tool-body")).not.toContainText(
        "<subagent",
      );
      const execute = page.locator('[data-tool="external"]').filter({
        hasText: "execute",
      });
      await expect(execute).toHaveClass(/is-error/);
      await expect(execute).toContainText("No such file: missing");
      await execute.locator(".otk-tool-toggle").first().click();
      await expect(execute.locator('[data-tool="external"]')).toContainText(
        "read",
      );
      await state.product("prefs.set", { key: "toolDetails", value: false });
      await expect(execute).toBeVisible();
      await page.reload();
      await expect(failed).toBeVisible();
      await revealAcquired(
        page,
        '[data-native-record="opencode-v2/request-outcome"]',
      );
      await expect(
        page.locator('[data-native-record="opencode-v2/request-outcome"]'),
      ).toBeVisible();
    },
  );
});
