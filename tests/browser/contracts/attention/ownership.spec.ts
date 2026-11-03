// SPDX-License-Identifier: LGPL-3.0-only
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { stopUnit, unitInventory } from "../../fixtures/protocol.ts";

const exec = promisify(execFile);
test(
  "attention.notification-profile-failure-video-and-worker-crash-leave-no-owned-resources",
  { tag: ["@attention", "@fixture-acceptance"] },
  async ({ browserName: _browserName }, info) => {
    test.setTimeout(120_000);
    for (const scenario of ["notification-body", "notification-worker-crash"]) {
      const unit =
        `${process.env.OTK_TEST_RUN}-negative-${scenario}-${randomUUID()}.service`;
      const environment = Object.entries(process.env).filter(([key, value]) =>
        value !== undefined &&
        (key.startsWith("OTK_TEST_") ||
          ["PATH", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH", "HOME"].includes(key))
      ).map(([key, value]) => `--setenv=${key}=${value}`);
      let stdout = "", stderr = "", code = 0;
      try {
        const result = await exec("systemd-run", [
          "--user",
          "--wait",
          "--pipe",
          "--quiet",
          `--unit=${unit}`,
          "--property=KillMode=control-group",
          `--working-directory=${join(process.cwd(), "../..")}`,
          ...environment,
          `--setenv=OTK_TEST_FORCED=${scenario}`,
          "deno",
          "run",
          "-A",
          "scripts/tests/browser.ts",
          `--project=${info.project.name}`,
          "--grep",
          "@notification-forced",
          "--workers=1",
          "--retries=0",
        ], { timeout: 50_000, maxBuffer: 4 * 1024 * 1024 });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (error) {
        const result = error as {
          code: number;
          stdout: string;
          stderr: string;
        };
        code = result.code;
        stdout = result.stdout;
        stderr = result.stderr;
      } finally {
        await stopUnit(unit);
      }
      await info.attach(`forced-${scenario}`, {
        body: JSON.stringify({ code, stdout, stderr }),
        contentType: "application/json",
      });
      expect(typeof code).toBe("number");
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain(
        scenario === "notification-body"
          ? "Forced notification profile body failure"
          : "worker process exited unexpectedly",
      );
      const receiptPath = /Browser run receipt:\s*(\S+\/run\.json)/.exec(
        stdout + stderr,
      )?.[1];
      expect(receiptPath).toBeTruthy();
      const receipt = JSON.parse(await readFile(receiptPath!, "utf8"));
      expect(receipt.cleanupErrors).toEqual([]);
      const root = join(receiptPath!, "..");
      const records = await unitInventory(join(root, "units.jsonl"));
      expect(records.some((r) => r.unit.includes("-notification-browser-")))
        .toBe(true);
      for (const record of records) {
        expect(record.unit).not.toContain("-worker-");
        const { stdout } = await exec("systemctl", [
          "--user",
          "show",
          record.unit,
          "--property=ControlGroup",
          "--value",
        ], { timeout: 5000 });
        expect(stdout.trim()).toBe("");
        const owned = JSON.parse(
          await readFile(join(record.root, "owned.json"), "utf8"),
        );
        for (const pid of owned.pids) {
          await expect(access(`/proc/${pid}`))
            .rejects.toMatchObject({ code: "ENOENT" });
        }
        for (const port of owned.ports) {
          await expect(
            fetch(`http://127.0.0.1:${port}`, {
              signal: AbortSignal.timeout(1000),
            }),
          ).rejects.toThrow();
        }
      }
      if (scenario === "notification-body") {
        const report = JSON.parse(
          await readFile(join(root, "results.json"), "utf8"),
        );
        const attachments: { path?: string; contentType?: string }[] = [];
        const visit = (
          suite: {
            specs?: {
              tests: { results: { attachments?: typeof attachments }[] }[];
            }[];
            suites?: unknown[];
          },
        ) => {
          for (const spec of suite.specs ?? []) {
            for (const test of spec.tests) {
              for (const result of test.results) {
                attachments.push(
                  ...result.attachments ?? [],
                );
              }
            }
          }
          for (const child of suite.suites ?? []) visit(child as typeof suite);
        };
        for (const suite of report.suites) visit(suite);
        for (const type of ["image/png", "application/zip", "video/webm"]) {
          const attachment = attachments.find((a) =>
            a.contentType === type && a.path
          );
          expect(attachment, `first failure retains ${type}`).toBeTruthy();
          expect((await stat(attachment!.path!)).size).toBeGreaterThan(0);
        }
      }
    }
  },
);
