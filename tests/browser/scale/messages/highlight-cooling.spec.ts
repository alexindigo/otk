// SPDX-License-Identifier: LGPL-3.0-only
import { isolatedTest as test } from "../../fixtures/isolated.ts";
import { coolingCycles } from "../../fixtures/highlight-cooling.ts";
import { heapPort } from "../../fixtures/heap.ts";
import { measureSessionHeap } from "../../../support/heap.ts";

test.use({ profile: "messages-cooling" });
test("messages.highlight-cooling-heap-samples", {
  tag: ["@messages", "@scale"],
}, async ({ isolatedState: state, page, context }, info) => {
  test.setTimeout(180_000);
  const cdp = await context.newCDPSession(page),
    port = await heapPort(context, page);
  try {
    const samples = await coolingCycles(
      state,
      page,
      cdp,
      (sessionID) => measureSessionHeap(port, sessionID, "const heap0:"),
    );
    console.info("Code history session identities", JSON.stringify(samples));
    await info.attach("highlight-cooling-samples", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
  } finally {
    await port.close();
    await cdp.detach();
  }
});
