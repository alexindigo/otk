// SPDX-License-Identifier: LGPL-3.0-only
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
} from "@playwright/test/reporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { outcome } from "../../scripts/tests/report.ts";
import { validateCollection } from "../../scripts/tests/selection.ts";
import quarantine from "./quarantine.json" with { type: "json" };

export default class Outcomes implements Reporter {
  private tests: TestCase[] = [];
  private config!: FullConfig;
  private invalid: string | undefined;
  onBegin(config: FullConfig, suite: Suite) {
    this.config = config;
    this.tests = suite.allTests();
    try {
      if (!this.tests.length) {
        throw new Error("Empty accidental browser selection");
      }
      if (process.env.OTK_TEST_STANDARD_COLLECTION === "1") {
        validateCollection(this.tests.map((t) => t.tags));
        for (const project of config.projects) {
          const smoke = this.tests.filter((t) =>
            t.parent.project()!.name === project.name &&
            t.tags.includes("@smoke")
          );
          const ids = smoke.flatMap((t) =>
            t.tags.filter((tag) => tag.startsWith("@smoke."))
          );
          if (
            smoke.length !== 4 || ids.length !== 4 ||
            ["native-prompt", "attention", "navigation", "preferences"].some((
              id,
            ) => !ids.includes(`@smoke.${id}`))
          ) throw new Error(`Incomplete smoke contract: ${project.name}`);
        }
      }
    } catch (error) {
      this.invalid = String(error);
      console.error(this.invalid);
    }
  }
  onEnd(result: FullResult) {
    const rows = this.tests.map((test) => {
      const project = test.parent.project()!.name;
      const active = quarantine.some((q: { id: string; project: string }) =>
        q.id === test.title && q.project === project
      );
      return {
        id: test.id,
        stableID: test.title,
        project,
        tags: test.tags,
        smokeID: test.tags.find((tag) => tag.startsWith("@smoke."))?.slice(1),
        ...outcome(test.results.map((r) => r.status), active),
        attempts: test.results.map((r) => ({
          retry: r.retry,
          status: r.status,
          duration: r.duration,
          timing: {
            setupMs: r.steps.filter((s) => s.title === "Before Hooks").reduce(
              (n, s) => n + s.duration,
              0,
            ),
            cleanupMs: r.steps.filter((s) => s.title === "After Hooks").reduce(
              (n, s) => n + s.duration,
              0,
            ),
            totalMs: r.duration,
          },
          errors: r.errors,
          attachments: r.attachments,
        })),
      };
    });
    const root = process.env.OTK_TEST_RUN_ROOT ??
      this.config.projects[0].outputDir;
    mkdirSync(root, { recursive: true });
    const counts = Object.fromEntries(
      ["first-pass", "flaky", "failed", "quarantined", "not-run"].map((
        c,
      ) => [c, rows.filter((r) => r.category === c).length]),
    );
    writeFileSync(
      join(root, "outcomes.json"),
      JSON.stringify(
        {
          tree: process.env.OTK_TEST_TREE,
          base: process.env.OTK_TEST_BASE,
          selection: process.env.OTK_TEST_SELECTION,
          status: result.status,
          collectionError: this.invalid,
          counts,
          rows,
        },
        null,
        2,
      ),
    );
    console.log("Outcomes:", JSON.stringify(counts));
    if (
      this.invalid ||
      !process.argv.includes("--list") &&
        (result.status !== "passed" || rows.some((r) => r.exit !== 0))
    ) {
      return Promise.resolve({ status: "failed" as const });
    }
    return Promise.resolve();
  }
}
