// SPDX-License-Identifier: LGPL-3.0-only
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import Outcomes from "../reporter.ts";

const root = resolve(
  ".test-state/runs",
  `reporter-attachments-${crypto.randomUUID()}`,
);
mkdirSync(root, { recursive: true });
process.env.OTK_TEST_RUN_ROOT = root;
const body = Buffer.alloc(256 * 1024, 255);
const tests = Array.from({ length: 128 }, (_, i) => ({
  id: `attachment-${i}`,
  title: `attachment-${i}`,
  tags: ["@harness"],
  parent: { project: () => ({ name: "reporting" }) },
  results: [{
    retry: 0,
    status: "passed",
    duration: 1,
    steps: [],
    errors: [],
    attachments: [{
      name: "binary-evidence",
      contentType: "application/octet-stream",
      body,
    }],
  }],
}));
const reporter = new Outcomes();
reporter.onBegin(
  {} as FullConfig,
  { allTests: () => tests } as unknown as Suite,
);
for (const item of tests) {
  reporter.onTestEnd(
    item as unknown as TestCase,
    item.results[0] as unknown as TestResult,
  );
  assert.equal(item.results[0].attachments[0].body, undefined);
}
await reporter.onEnd({ status: "passed" } as FullResult);
const metadata = readFileSync(join(root, "outcomes.json"), "utf8");
assert(
  metadata.length < 256 * 1024,
  "outcome metadata must not inline evidence bytes",
);
const report = JSON.parse(metadata);
assert.equal(report.counts["first-pass"], 128);
for (const row of report.rows) {
  const attachment = row.attempts[0].attachments[0];
  assert.equal(attachment.name, "binary-evidence");
  assert.equal(attachment.contentType, "application/octet-stream");
  assert.equal(attachment.body, undefined);
  assert.deepEqual(readFileSync(attachment.path), body);
}
console.log(
  "Reporter retained every attachment byte with bounded outcome metadata:",
  root,
);
