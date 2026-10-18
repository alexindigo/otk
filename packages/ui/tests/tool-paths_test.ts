// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { relativeTarget } from "../components/tools/paths.ts";

Deno.test("tool path presentation keeps project descendants relative and outside targets absolute", () => {
  for (
    const [path, directory, expected] of [
      ["/work/project/src/a.ts", "/work/project", "src/a.ts"],
      ["/work/project/src/", "/work/project/", "src/"],
      ["/work/project/./src/../a.ts", "/work/project/.", "a.ts"],
      ["/work/project", "/work/project/", "."],
      ["/work/project-old/a.ts", "/work/project", "/work/project-old/a.ts"],
      [
        "/work/project/../outside/a.ts",
        "/work/project",
        "/work/project/../outside/a.ts",
      ],
      ["/etc/hosts", "/work/project", "/etc/hosts"],
      ["src/a.ts", "/work/project", "src/a.ts"],
      ["/work/project/a.ts", undefined, "/work/project/a.ts"],
      ["/etc/hosts", "/", "etc/hosts"],
      ["", "/work/project", ""],
    ]
  ) assertEquals(relativeTarget(path!, directory), expected);
});
