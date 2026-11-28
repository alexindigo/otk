// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { StorageAvailability } from "@otk/store";
import { DigestBridge } from "../../../core/digest/bridge.ts";
import type { FromWorker, ToWorker } from "../../../core/digest/protocol.ts";
import { test } from "../../support/resources.ts";
import { cfg, fixture } from "./support.ts";

test("a replacement worker inherits the parent's requirement for a real storage commit", async () => {
  const statePath = await fixture(), settings = cfg();
  const owner = new StorageAvailability();
  owner.remote(`${statePath}/digest-worker`, {
    degraded: true,
    problem: "full",
    gap: 1,
  });
  const commands: ToWorker[] = [];
  class TestWorker {
    onmessage?: (message: { data: FromWorker }) => void;
    onerror?: (event: ErrorEvent) => void;
    postMessage(message: ToWorker): void {
      commands.push(message);
      if (message.t !== "start" && message.t !== "stop") return;
      const t = message.t === "start" ? "accepted" : "stopped";
      queueMicrotask(() =>
        this.onmessage?.({ data: { t, run: message.run, id: message.id } })
      );
    }
    terminate(): void {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker")!;
  Object.defineProperty(globalThis, "Worker", {
    ...descriptor,
    value: TestWorker,
  });
  const bridge = new DigestBridge({
    statePath,
    provider: "opencode-v1",
    native: settings,
    policy: settings.digest,
    storage: owner,
    publish() {},
  });
  try {
    await bridge.start();
    const start = commands.find((command) => command.t === "start");
    assertEquals(start?.t === "start" && start.storageRecovery, true);
    assertEquals(
      owner.status().degraded,
      true,
      "accepting or reopening alone cannot clear a retained storage fault",
    );
  } finally {
    try {
      await bridge.stop();
    } finally {
      Object.defineProperty(globalThis, "Worker", descriptor);
    }
  }
});
