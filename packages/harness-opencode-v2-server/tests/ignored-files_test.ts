// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { waitFor } from "../../../tests/support/opencode.ts";
import { ignoredFiles } from "../ignored-files.ts";
import { tempDir, test } from "../../../tests/support/resources.ts";

test("V2 Git ignore authority preserves nested rules, wildcards, exceptions and NUL-delimited names", async () => {
  const root = await tempDir("git-ignore-");
  const init = await new Deno.Command("git", { args: ["init", "-q", root] })
    .output();
  assertEquals(init.code, 0);
  await Deno.mkdir(root + "/nested");
  await Deno.writeTextFile(
    root + "/.gitignore",
    "*.log\n!keep.log\nprivate/\n",
  );
  await Deno.writeTextFile(root + "/nested/.gitignore", "*.tmp\n!keep.tmp\n");
  await Deno.writeTextFile(root + "/.git/info/exclude", "local-only.txt\n");
  const paths = [
    "drop.log",
    "keep.log",
    "private/",
    "nested/drop.tmp",
    "nested/keep.tmp",
    "nested/ok.txt",
    "local-only.txt",
    "space and\tname.log",
  ];
  assertEquals([
    ...await ignoredFiles(root, paths, new AbortController().signal),
  ], [
    "drop.log",
    "private/",
    "nested/drop.tmp",
    "local-only.txt",
    "space and\tname.log",
  ]);
  const plain = await tempDir("non-repo-ignore-");
  assertEquals([
    ...await ignoredFiles(plain, ["plain.txt"], new AbortController().signal),
  ], []);
  const controller = new AbortController();
  controller.abort();
  await assertRejects(
    () => ignoredFiles(root, paths, controller.signal),
    DOMException,
    "abort",
  );
  const previous = Deno.env.get("PATH");
  Deno.env.set("PATH", root + "/missing-tools");
  try {
    await assertRejects(
      () => ignoredFiles(root, paths, new AbortController().signal),
      Error,
      "Git is unavailable",
    );
  } finally {
    if (previous === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", previous);
  }
  const tools = await tempDir("held-git-");
  const pidfile = tools + "/pid";
  await Deno.writeTextFile(
    tools + "/git",
    `#!/bin/sh\necho $$ > '${pidfile}'\nwhile :; do :; done\n`,
    { mode: 0o700 },
  );
  Deno.env.set("PATH", tools);
  const cancel = new AbortController();
  const pending = ignoredFiles(root, paths, cancel.signal).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  try {
    const pid = Number(
      await waitFor(() => Deno.readTextFile(pidfile), Boolean),
    );
    cancel.abort();
    const result = await pending;
    assert("error" in result);
    const alive = await new Deno.Command("/usr/bin/kill", {
      args: ["-0", String(pid)],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      alive.success,
      false,
      "Cancellation must join the owned Git process",
    );
  } finally {
    cancel.abort();
    await pending;
    if (previous === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", previous);
  }
});
