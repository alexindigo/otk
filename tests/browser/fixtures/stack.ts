// SPDX-License-Identifier: LGPL-3.0-only
import { test as base } from "@playwright/test";
import { Controller } from "./protocol.ts";

export const test = base.extend<Record<never, never>, { stack: Controller }>({
  stack: [async ({ browserName: _browserName }, use, workerInfo) => {
    const version = workerInfo.project.name.replace(/^oc-/, "");
    const start = performance.now();
    const controller = await new Controller(
      `worker-${workerInfo.workerIndex}-${workerInfo.project.name}`,
      version,
    ).start();
    console.info(
      JSON.stringify({
        worker: workerInfo.workerIndex,
        setupSeconds: (performance.now() - start) / 1000,
        stack: controller.info,
      }),
    );
    try {
      await use(controller);
    } finally {
      const cleanup = performance.now();
      await controller.stop();
      console.info(
        JSON.stringify({
          worker: workerInfo.workerIndex,
          cleanupSeconds: (performance.now() - cleanup) / 1000,
        }),
      );
    }
  }, { scope: "worker", timeout: 120_000 }],
});
