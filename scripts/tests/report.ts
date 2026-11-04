// SPDX-License-Identifier: LGPL-3.0-only
export type Quarantine = {
  id: string;
  project: string;
  reason: string;
  failureClass: string;
  issue: string;
  owner: string;
  expiry: string;
};
export function validateQuarantine(
  entries: Quarantine[],
  collection: { id: string; project: string }[],
  now = new Date(),
) {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      ["id", "project", "reason", "failureClass", "issue", "owner", "expiry"]
        .some((k) =>
          typeof entry[k as keyof Quarantine] !== "string" ||
          !entry[k as keyof Quarantine].trim()
        )
    ) throw new Error("Incomplete quarantine metadata");
    if (
      !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(entry.expiry) ||
      !Number.isFinite(Date.parse(entry.expiry)) ||
      Date.parse(entry.expiry) <= +now
    ) throw new Error("Invalid/expired quarantine");
    const key = `${entry.project}:${entry.id}`;
    if (seen.has(key)) throw new Error("Duplicate quarantine");
    seen.add(key);
    if (
      !collection.some((test) =>
        test.id === entry.id && test.project === entry.project
      )
    ) throw new Error("Unknown quarantine test/project");
  }
}
export function outcome(statuses: string[], quarantined = false) {
  const result = !statuses.length || statuses.every((s) => s === "skipped")
    ? "not-run"
    : statuses.at(-1) !== "passed"
    ? "failed"
    : statuses.some((s) => s !== "passed")
    ? "flaky"
    : "first-pass";
  return {
    outcome: result,
    category: quarantined ? "quarantined" : result,
    label: quarantined && result === "first-pass"
      ? "passed; active quarantine metadata"
      : result,
    exit: result === "first-pass" ? 0 : 1,
  };
}
