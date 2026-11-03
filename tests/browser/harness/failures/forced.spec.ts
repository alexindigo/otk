// SPDX-License-Identifier: LGPL-3.0-only
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isolatedTest } from "../../fixtures/isolated.ts";
import { notificationTest } from "../../fixtures/notifications.ts";
import {
  focusNotifications,
  hideNotifications,
} from "../../pages/notifications.ts";

const scenario = process.env.OTK_TEST_FORCED;
notificationTest(`forced notification profile ${scenario}`, {
  tag: ["@notification-forced", "@attention"],
}, async ({ page }) => {
  await page.goto(
    "data:text/html,<title>Notification failure evidence</title><button>Native visibility</button>",
  );
  await focusNotifications(page);
  const restore = await hideNotifications(page);
  await restore();
  if (scenario === "notification-worker-crash") {
    process.kill(process.pid, "SIGKILL");
  }
  throw new Error("Forced notification profile body failure");
});
const test = isolatedTest.extend<{ failureEvidence: void }>({
  failureEvidence: [async ({ context }, use) => {
    try {
      await use();
    } finally {
      await context.close();
      await writeFile(
        join(process.env.OTK_TEST_RUN_ROOT!, "context-closed.json"),
        JSON.stringify({ closed: true, pages: context.pages().length }),
      );
    }
    if (scenario === "evidence") {
      throw new Error("Forced evidence capture failure");
    }
    if (scenario === "body-evidence-teardown") {
      throw new Error("Forced evidence capture failure after body failure");
    }
  }, { auto: true }],
});
test.use({
  profile: scenario === "start"
    ? "fail-start"
    : scenario === "teardown" || scenario === "body-evidence-teardown"
    ? "fail-teardown"
    : "isolated",
});
test(
  `forced fixture ${scenario}`,
  { tag: ["@forced", "@harness"] },
  async ({ isolatedState, page }) => {
    await isolatedState.native("/session", "POST", {
      title: "Failure control",
    });
    await page.goto(isolatedState.url);
    if (scenario === "worker-crash") {
      await writeFile(
        join(process.env.OTK_TEST_RUN_ROOT!, "context-open.json"),
        JSON.stringify({ open: true }),
      );
      process.kill(process.pid, "SIGKILL");
    }
    if (scenario === "body" || scenario === "body-evidence-teardown") {
      throw new Error("Forced test-body failure");
    }
    if (scenario === "crash") {
      process.kill(isolatedState.controller.info!.pids[0], "SIGKILL");
      await isolatedState.observe();
    }
  },
);
