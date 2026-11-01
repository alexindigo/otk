// SPDX-License-Identifier: LGPL-3.0-only
import { legacyFiles } from "./migration-audit.ts";
// Required-value options in the pinned Deno 2.9.6 test CLI. Optional values use
// --option=value, except --lock, which also accepts a separate path.
const values = new Set([
  "--filter",
  "--coverage-threshold",
  "--reporter",
  "--junit-path",
  "--retry",
  "--repeats",
  "--shard",
  "--related",
  "--ext",
  "--import-map",
  "--node-modules-linker",
  "--config",
  "-c",
  "--cert",
  "--min-dep-age",
  "--inspect-publish-uid",
  "--location",
  "--seed",
  "--preload",
  "--require",
  "--conditions",
]);
const root = new URL("../../tests/e2e/", import.meta.url);
let explicitPath = false;
for (let i = 0; i < Deno.args.length; i++) {
  const arg = Deno.args[i];
  if (arg === "--") break;
  if (values.has(arg)) {
    i++;
    continue;
  }
  if (
    arg === "--lock" && Deno.args[i + 1] && !Deno.args[i + 1].startsWith("-")
  ) {
    i++;
    continue;
  }
  if (arg.startsWith("-")) continue;
  const path = new URL(arg, new URL("../../", import.meta.url)).href;
  if (path !== root.href.slice(0, -1) && !path.startsWith(root.href)) {
    throw new Error(`Legacy test paths must stay inside tests/e2e/: ${arg}`);
  }
  explicitPath = true;
}
const active = await legacyFiles();
const files = explicitPath ? Deno.args : [...active, ...Deno.args];
if (!active.length) {
  console.info("No active legacy assertions");
  Deno.exit(0);
}
const status = await new Deno.Command(Deno.execPath(), {
  args: ["task", "test", ...files],
  stdin: "inherit",
  signal: AbortSignal.timeout(24 * 60 * 60_000),
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
Deno.exit(status.code);
