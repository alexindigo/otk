// SPDX-License-Identifier: LGPL-3.0-only
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures/evidence.ts";
import { stopUnit, unitInventory } from "../fixtures/protocol.ts";

const exec = promisify(execFile);
for (
  const scenario of [
    "start",
    "body",
    "evidence",
    "teardown",
    "body-evidence-teardown",
    "crash",
    "worker-crash",
  ]
) {
  test(`fixture forced ${scenario} leaves no owned resources`, {
    tag: ["@fixture-acceptance", "@harness"],
  }, async ({ browserName: _browserName }, info) => {
    test.setTimeout(180_000);
    const unit =
      `${process.env.OTK_TEST_RUN}-negative-${scenario}-${randomUUID()}.service`;
    const environment = Object.entries(process.env).filter(([key, value]) =>
      value !== undefined && (
        key.startsWith("OTK_TEST_") ||
        ["PATH", "TMPDIR", "PLAYWRIGHT_BROWSERS_PATH", "HOME"].includes(key)
      )
    ).map(([key, value]) => `--setenv=${key}=${value}`);
    let stdout = "", stderr = "", code = 0;
    try {
      const result = await exec("systemd-run", [
        "--user",
        "--pipe",
        "--wait",
        "--quiet",
        `--unit=${unit}`,
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=10s",
        `--working-directory=${join(process.cwd(), "../..")}`,
        ...environment,
        `--setenv=OTK_TEST_FORCED=${scenario}`,
        "deno",
        "run",
        "-A",
        "scripts/tests/browser.ts",
        `--project=${info.project.name}`,
        "--grep",
        "@forced",
        "--workers=1",
        "--retries=0",
      ], { timeout: 160_000, maxBuffer: 4 * 1024 * 1024 });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const result = error as { code: number; stdout: string; stderr: string };
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
      scenario === "start"
        ? "Forced controller-start failure"
        : scenario === "body" || scenario === "body-evidence-teardown"
        ? "Forced test-body failure"
        : scenario === "evidence"
        ? "Forced evidence capture failure"
        : scenario === "teardown"
        ? "Forced controller teardown failure"
        : scenario === "worker-crash"
        ? "worker process exited unexpectedly"
        : "Controller exited",
    );
    const receiptPath = /Browser run receipt:\s*(\S+\/run\.json)/.exec(
      stdout + stderr,
    )?.[1];
    if (scenario === "body-evidence-teardown") {
      // The transferred Deno lifetime control failed body, evidence and a
      // disposer together: preserve all causes, then prove later cleanup ran.
      expect(stdout + stderr).toContain(
        "Forced evidence capture failure after body failure",
      );
      expect(stdout + stderr).toContain("Forced controller teardown failure");
      expect((stdout + stderr).indexOf("Forced test-body failure"))
        .toBeLessThan(
          (stdout + stderr).indexOf(
            "Forced evidence capture failure after body failure",
          ),
        );
    }
    expect(receiptPath, "child supervisor must finish and write its receipt")
      .toBeTruthy();
    const receipt = JSON.parse(await readFile(receiptPath!, "utf8"));
    expect(
      receipt.parentRun,
      "negative control remains owned by its qualification run",
    )
      .toBe(process.env.OTK_TEST_RUN);
    expect(receipt.cleanupErrors).toEqual([]);
    const root = join(receiptPath!, "..");
    for (const owned of await unitInventory(join(root, "units.jsonl"))) {
      expect(
        owned.unit,
        "isolated fixture must not acquire an ordinary worker stack",
      ).not.toContain("-worker-");
      const { stdout: cgroup } = await exec("systemctl", [
        "--user",
        "show",
        owned.unit,
        "--property=ControlGroup",
        "--value",
      ], { timeout: 5000 });
      expect(cgroup.trim()).toBe("");
      const ownership = JSON.parse(
        await readFile(join(owned.root, "owned.json"), "utf8"),
      );
      if (scenario === "body-evidence-teardown") {
        const stack = JSON.parse(
          await readFile(join(owned.root, "stack.json"), "utf8"),
        );
        await expect(
          access(stack.root),
          "native TMPDIR root is removed despite all three failures",
        )
          .rejects.toMatchObject({ code: "ENOENT" });
      }
      await readFile(join(owned.root, "native.log"), "utf8");
      expect(
        Array.isArray(
          JSON.parse(
            await readFile(join(owned.root, "provider-requests.json"), "utf8"),
          ),
        ),
      ).toBe(true);
      if (scenario === "start") {
        expect(ownership.sidecarPort).toBeUndefined();
      } else {
        expect(ownership.sidecarPort).toBeGreaterThan(0);
        await readFile(
          join(owned.root, `sidecar-${ownership.sidecarPort}.log`),
          "utf8",
        );
      }
      for (const pid of ownership.pids) {
        expect(() => process.kill(pid, 0)).toThrow();
      }
      for (const port of ownership.ports) {
        await expect(
          fetch(`http://127.0.0.1:${port}`, {
            signal: AbortSignal.timeout(1000),
          }),
        ).rejects.toThrow();
      }
    }
    const { stdout: group } = await exec("systemctl", [
      "--user",
      "show",
      unit,
      "--property=ControlGroup",
      "--value",
    ], { timeout: 5000 });
    expect(group.trim(), "child browser process cgroup is empty").toBe("");
    if (scenario === "worker-crash") {
      expect(
        JSON.parse(await readFile(join(root, "context-open.json"), "utf8")),
      ).toEqual({ open: true });
      // Abrupt death cannot run a JS disposer; the empty browser cgroup proves
      // that its contexts cannot outlive the child invocation.
      await expect(readFile(join(root, "context-closed.json"))).rejects
        .toThrow();
      return;
    }
    const context = JSON.parse(
      await readFile(join(root, "context-closed.json"), "utf8"),
    );
    expect(context).toEqual({ closed: true, pages: 0 });
  });
}
