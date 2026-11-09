// SPDX-License-Identifier: LGPL-3.0-only
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures/evidence.ts";
import { Controller } from "../fixtures/protocol.ts";
import type { TestLease } from "../../support/fixture-control.ts";

for (const remote of [false, true]) {
  test(
    `fixture shutdown joins unresponsive ${
      remote ? "local and remote" : "local"
    } services`,
    {
      tag: ["@fixture-acceptance", "@harness"],
    },
    async ({ browserName: _browserName }, info) => {
      const controller = await new Controller(
        `shutdown-${randomUUID()}`,
        info.project.name.replace(/^(?:oc|scale)-/, ""),
      ).start("isolated");
      try {
        const lease = await controller.call<TestLease>("beginTest", {
          identity: info.testId,
        });
        if (remote) {
          await controller.call("auxiliary", {
            lease: lease.lease,
            kind: "remote-open",
          });
        }
        const ownership = JSON.parse(
          await readFile(join(controller.root, "owned.json"), "utf8"),
        ) as { pids: number[]; ports: number[] };
        expect(ownership.pids).toHaveLength(remote ? 5 : 3);
        // Stop the actual service processes, not the controller: each process owner
        // must exhaust its own TERM grace and join its KILL/reap before acknowledging.
        for (const pid of ownership.pids.slice(1)) process.kill(pid, "SIGSTOP");
        const started = performance.now();
        await controller.stop();
        await info.attach("joined-shutdown", {
          body: JSON.stringify({
            services: ownership.pids.length - 1,
            milliseconds: performance.now() - started,
          }),
          contentType: "application/json",
        });
        expect(
          JSON.parse(
            await readFile(join(controller.root, "cleanup.json"), "utf8"),
          )
            .errors,
        ).toEqual([]);
        await expect(access(controller.info!.root)).rejects.toMatchObject({
          code: "ENOENT",
        });
        for (const pid of ownership.pids) {
          expect(() => process.kill(pid, 0)).toThrow();
        }
        for (const port of ownership.ports) {
          await expect(fetch(`http://127.0.0.1:${port}`, {
            signal: AbortSignal.timeout(1000),
          })).rejects.toThrow();
        }
      } finally {
        await controller.stop();
      }
    },
  );
}
