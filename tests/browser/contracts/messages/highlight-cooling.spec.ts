// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { coolingCycles } from "../../fixtures/highlight-cooling.ts";

test.use({ profile: "messages-cooling" });
test("messages.highlight-cooling-worker-lifetime", {
  tag: ["@messages", "@contracts"],
}, async ({ isolatedState: state, page, context }) => {
  test.setTimeout(180_000);
  const cdp = await context.newCDPSession(page);
  await coolingCycles(state, page, cdp);
  await cdp.detach();
});
