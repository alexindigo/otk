// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { canonicalPath, relativePath } from "../paths.ts";
const posix = { style: "posix", separator: "/" } as const;
const win = { style: "win32", separator: "\\" } as const;
Deno.test("server path semantics preserve POSIX boundaries and opaque URI references", () => {
  assertEquals(
    canonicalPath("src/../file.ts", "/project", posix),
    "/project/file.ts",
  );
  assertEquals(
    relativePath("/project/src/../file.ts", "/project", posix),
    "file.ts",
  );
  assertEquals(
    relativePath("/project-other/file", "/project", posix),
    "/project-other/file",
  );
  assertEquals(
    relativePath("/Project/file", "/project", posix),
    "/Project/file",
  );
  assertEquals(
    canonicalPath("file://localhost/a%20b", "/project", posix),
    "file://localhost/a%20b",
  );
});
Deno.test("server Windows drive and UNC paths are lexical and independent of browser OS", () => {
  assertEquals(
    canonicalPath("src/../file.ts", "C:\\Project", win),
    "C:\\Project\\file.ts",
  );
  assertEquals(
    relativePath("c:\\project\\src\\file.ts", "C:\\Project", win),
    "src\\file.ts",
  );
  assertEquals(relativePath("D:\\file", "C:\\Project", win), "D:\\file");
  assertEquals(
    relativePath(
      "\\\\server\\share\\Project\\file",
      "\\\\SERVER\\share\\Project",
      win,
    ),
    "file",
  );
  assertEquals(
    relativePath("\\\\server\\other\\file", "\\\\server\\share", win),
    "\\\\server\\other\\file",
  );
  assertEquals(canonicalPath("\\rooted", "C:\\Project", win), "C:\\rooted");
});
