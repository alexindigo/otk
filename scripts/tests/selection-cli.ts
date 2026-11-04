// SPDX-License-Identifier: LGPL-3.0-only
import { pathsFromNul, select } from "./selection.ts";
const file = Deno.args[Deno.args.indexOf("--changed-paths") + 1];
console.log(
  JSON.stringify(
    select(
      pathsFromNul(await Deno.readFile(file)),
      [],
      Deno.env.get("OTK_TEST_BASE"),
    ),
    null,
    2,
  ),
);
