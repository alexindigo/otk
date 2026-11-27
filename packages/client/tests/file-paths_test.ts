// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  folderCommand,
  hrefPath,
  pathSegments,
  sessionMentionID,
  textRuns,
} from "../file-paths.ts";
import { formatBytes } from "../format.ts";

Deno.test("the shared linkifier recognizes native session IDs without changing the text", () => {
  const id = "ses_de5e7f01fffeN4upKbwEeHRkSJ";
  const reference = { raw: id, sessionID: id };
  for (
    const [text, where] of [[id, "prose"], [
      `See (${id}), then continue.`,
      "prose",
    ], [id, "code"]] as const
  ) {
    const segments = pathSegments(text, where);
    assertEquals<unknown>(
      segments.flatMap(({ mention }) => mention ? [mention] : []),
      [reference],
    );
    assertEquals(segments.map((segment) => segment.text).join(""), text);
  }
  for (const text of [`prefix_${id}`, `${id}Z`, "ses_not_an_id"]) {
    assertEquals(pathSegments(text, "prose"), [{ text }]);
  }
  // Lexical recognition never asserts existence; an unresolved reference still
  // carries the exact text the presenter must fall back to.
  const unknown = "ses_000000000000UnknownSession";
  assertEquals(pathSegments(unknown, "code")[0].text, unknown);
  assertEquals(sessionMentionID(id, `opcv2-${id}`), `opcv2-${id}`);
  assertEquals(sessionMentionID(`opcv2-${id}`, `opcv1-${id}`), `opcv2-${id}`);
  assertEquals(sessionMentionID(unknown), undefined);
});

Deno.test("path recognition is conservative in prose and whole-span code", () => {
  const mentions = (text: string, where: "prose" | "code" = "prose") =>
    pathSegments(text, where).flatMap(({ mention }) =>
      mention ? [mention] : []
    );
  const screenshot =
    "~/Documents/otk/screenshots/2026-11-24_1732_time-units-options-dark-125.png";
  for (
    const [text, raw] of [
      [`See ${screenshot}.`, screenshot],
      ["(see /home/u/a.txt).", "/home/u/a.txt"],
      ["See ~/plan,", "~/plan"],
      ["Read </home/person/a.txt>;", "/home/person/a.txt"],
    ]
  ) {
    assertEquals(mentions(text), [{ raw, path: raw }], text);
    assertEquals(pathSegments(text, "prose").map((s) => s.text).join(""), text);
  }
  for (
    const text of [
      "/api/users",
      "https://x.dev/a/b.png",
      "foo/bar.ts",
      "~/",
      "/home/.../a.ts",
      "//home/u/a.txt",
      "/1/2.3",
      "/home//a.txt",
      "x/home/u/a.txt",
      "/a.txt",
      "~/" + "x".repeat(1024),
    ]
  ) {
    assertEquals(mentions(text), [], text);
  }
  for (
    const text of [
      "console.log",
      "a.ts",
      "npm run build",
      "*.ts",
      "$HOME/x",
      "C:\\x",
      "http://x/y",
      "file:///x",
      "~/",
      "~",
      "/",
      "foo/bar",
      "src/a.ts extra",
      "src/?/a.ts",
      "src/[x]/a.ts",
      "src/$x/a.ts",
      "src/a.ts:0",
      "src/a.ts:3-2",
      "src/a.ts:9:0",
    ]
  ) {
    assertEquals(mentions(text, "code"), [], text);
  }
  for (
    const raw of [
      "/x",
      "~/config",
      "./x",
      "../x",
      "docs/",
      "foo/bar.ts",
      "src/élève.ts",
    ]
  ) {
    assertEquals(mentions(raw, "code"), [{ path: raw, raw }], raw);
  }
  for (
    const [suffix, start, end] of [
      [":12", 12, 12],
      [":12:4", 12, 12],
      [":12-20", 12, 20],
      ["#L3-L9", 3, 9],
      ["#L3", 3, 3],
    ] as const
  ) {
    for (
      const [path, mode] of [["a.ts", "code"], [
        "/home/u/a.ts",
        "prose",
      ]] as const
    ) {
      const raw = path + suffix;
      assertEquals(mentions(raw, mode), [{ raw, path, line: { start, end } }]);
    }
  }
  assertEquals(pathSegments("/home/u/a.ts", "prose", "win32"), [{
    text: "/home/u/a.ts",
  }]);
});

Deno.test("authored destinations allow local file URLs and decoded filenames", () => {
  for (
    const [raw, path] of [
      ["file:///x", "/x"],
      ["file://localhost/x", "/x"],
      ["~/x", "~/x"],
      ["./x", "./x"],
      ["notes/plan.md", "notes/plan.md"],
      [".envrc", ".envrc"],
      ["notes/a%20b.md", "notes/a b.md"],
    ]
  ) assertEquals(hrefPath(raw), { raw, path });
  assertEquals(hrefPath("file:///x#L2-L4"), {
    raw: "file:///x#L2-L4",
    path: "/x",
    line: { start: 2, end: 4 },
  });
  for (
    const raw of [
      "file://host/x",
      "https://x",
      "#top",
      "?page=1",
      "//net/x",
      "file:relative",
      "file:////x",
      "file:///x%00",
      "notes/%",
      "mailto:a@b",
    ]
  ) assertEquals(hrefPath(raw), undefined, raw);
  assertEquals(hrefPath("./x", "win32"), undefined);
});

Deno.test("adjacent text merges without crossing inline boundaries", () => {
  const code = { i: "code", text: "./file" } as const;
  const final = { i: "text", text: "tail" } as const;
  assertEquals(
    textRuns([{ i: "text", text: "a" }, { i: "text", text: "b" }, code, final]),
    [{ i: "text", text: "ab" }, code, final],
  );
});

Deno.test("path actions quote folders and use consistent byte units", () => {
  const fact = { path: "./a", size: 0, preview: "text" } as const;
  assertEquals(
    folderCommand({ ...fact, status: "file", resolved: "/parent/a" }),
    "cd -- '/parent'",
  );
  assertEquals(
    folderCommand({ ...fact, status: "file", resolved: "/a" }),
    "cd -- '/'",
  );
  assertEquals(
    folderCommand({ ...fact, status: "directory", resolved: "/a b/o'neil" }),
    "cd -- '/a b/o'\\''neil'",
  );
  assertEquals([0, 1023, 1024, 6246, 1468006].map(formatBytes), [
    "0 B",
    "1023 B",
    "1 KB",
    "6.1 KB",
    "1.4 MB",
  ]);
});
