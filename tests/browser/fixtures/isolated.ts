// SPDX-License-Identifier: LGPL-3.0-only
import { randomUUID } from "node:crypto";
import type { TestLease } from "../../support/fixture-control.ts";
import { test } from "./evidence.ts";
import { Controller, type Profile } from "./protocol.ts";
import { finishState, TestState } from "./test-state.ts";

export const isolatedTest = test.extend<
  { isolatedState: TestState; profile: Profile }
>({
  profile: ["isolated", { option: true }],
  isolatedState: async ({ profile, context }, use, info) => {
    const controller = await new Controller(
      `isolated-${info.workerIndex}-${randomUUID()}`,
      info.project.name.replace(/^(?:oc|scale)-/, ""),
    ).start(profile);
    try {
      const lease = await controller.call<TestLease>("beginTest", {
        identity: info.testId,
      });
      const state = new TestState(controller, lease, context);
      try {
        await use(state);
      } finally {
        await finishState(state, info);
      }
    } finally {
      await controller.stop();
    }
  },
});
