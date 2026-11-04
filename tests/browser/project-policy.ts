// SPDX-License-Identifier: LGPL-3.0-only
import quarantine from "./quarantine.json" with { type: "json" };
export function projectPolicy(name: string) {
  if (process.env.OTK_TEST_COLLECTION === "1") return {};
  const ids = quarantine.filter((q: { project: string }) => q.project === name)
    .map((q: { id: string }) => q.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(ids.length ? ids.join("|") : "(?!)");
  return process.env.OTK_TEST_QUARANTINE === "1"
    ? { grep: pattern }
    : { grepInvert: pattern };
}
