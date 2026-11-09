// SPDX-License-Identifier: LGPL-3.0-only
import { nativeLane } from "./lanes.ts";
import entries from "../../tests/browser/quarantine.json" with { type: "json" };
const version = Deno.args[0];
const projects = [
  `oc-${version}`,
  `scale-${version}`,
  ...(nativeLane(version, Deno.env.get("OTK_TEST_LANE")) === "A"
    ? ["themes"]
    : []),
];
let exit = 0;
for (const project of projects) {
  const active = entries.filter((q: { project: string }) =>
    q.project === project
  );
  console.info(
    "QUARANTINE LANE:",
    JSON.stringify({
      project,
      entries: active,
      retries: 0,
      status: active.length ? "running" : "empty (visible; no active metadata)",
    }),
  );
  if (!active.length) continue;
  const child = await new Deno.Command(Deno.execPath(), {
    args: [
      "task",
      project === "themes"
        ? "test:themes"
        : project.startsWith("scale")
        ? "test:scale"
        : "test:e2e",
      `--project=${project}`,
      "--retries=0",
    ],
    env: { OTK_TEST_QUARANTINE: "1" },
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  exit ||= child.code;
}
Deno.exit(exit);
