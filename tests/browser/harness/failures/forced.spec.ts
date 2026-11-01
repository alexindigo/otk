// SPDX-License-Identifier: LGPL-3.0-only
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isolatedTest } from "../../fixtures/isolated.ts";

const scenario = process.env.OTK_TEST_FORCED;
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
  }, { auto: true }],
});
test.use({
  profile: scenario === "start"
    ? "fail-start"
    : scenario === "teardown"
    ? "fail-teardown"
    : "isolated",
});
test(
  `forced fixture ${scenario}`,
  { tag: "@forced" },
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
    if (scenario === "body") throw new Error("Forced test-body failure");
    if (scenario === "crash") {
      process.kill(isolatedState.controller.info!.pids[0], "SIGKILL");
      await isolatedState.observe();
    }
  },
);
