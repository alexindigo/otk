// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { type Quarantine, validateQuarantine } from "./report.ts";
import entries from "../../tests/browser/quarantine.json" with { type: "json" };
const version = Deno.args[0];
if (!version || version !== Deno.env.get("OTK_TEST_VERSION")) {
  throw new Error("Collection version must match this lane's OTK_TEST_VERSION");
}
const projects = [`oc-${version}`, `scale-${version}`, "themes"];
const collection: { id: string; project: string }[] = [];
for (const kind of ["test", "scale", "themes"]) {
  const root = join(
    Deno.cwd(),
    ".test-state/runs",
    `collection-${kind}-${crypto.randomUUID()}`,
  );
  await Deno.mkdir(root, { recursive: true });
  const child = await new Deno.Command("npm", {
    args: [
      "--prefix",
      "tests/browser",
      "run",
      kind,
      "--",
      "--list",
      `--project=${
        kind === "test"
          ? projects[0]
          : kind === "scale"
          ? projects[1]
          : projects[2]
      }`,
    ],
    env: {
      OTK_TEST_COLLECTION: "1",
      OTK_TEST_STANDARD_COLLECTION: kind === "test" ? "1" : "0",
      OTK_TEST_RUN_ROOT: root,
    },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!child.success) Deno.exit(child.code);
  const report = JSON.parse(
    await Deno.readTextFile(join(root, "outcomes.json")),
  );
  for (const row of report.rows) {
    if (
      !row.tags.some((tag: string) =>
        /@(composer|messages|sessions|revert|attention|menus|visual|transport|harness|scale)$/
          .test(tag)
      )
    ) throw new Error(`No area: ${row.stableID}`);
    collection.push({ id: row.stableID, project: row.project });
  }
}
validateQuarantine(
  (entries as Quarantine[]).filter((entry) => projects.includes(entry.project)),
  collection,
);
console.info(
  "Validated collection and quarantine:",
  collection.length,
  "tests;",
  entries.length,
  "active entries",
);
