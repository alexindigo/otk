// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { Opencode1Adapter } from "../mod.ts";
import { HarnessError, requireCapability } from "@otk/harness";
import { StreamBuffers } from "@otk/content";
import { mapPromptParts } from "../mod.ts";

function adapterFor(root: string) {
  const settings = cfg();
  settings.harness.db = join(root, "missing.db");
  const session = {
    id: "ses_files",
    projectID: "project",
    directory: root,
    title: "Files",
    time: { created: 1, updated: 1 },
  };
  return new Opencode1Adapter(settings, new StreamBuffers(), (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/session/ses_files") {
      return Promise.resolve(Response.json(session));
    }
    assertEquals(url.pathname, "/find/file");
    return Promise.resolve(Response.json(["src/file.ts", "blocked/file.ts"]));
  });
}

test("permission-denied discovery candidates are skipped but explicit prompt files reject", async () => {
  const root = await fixture();
  await Deno.mkdir(join(root, "src"));
  await Deno.mkdir(join(root, "blocked"));
  await Deno.writeTextFile(join(root, "src/file.ts"), "readable");
  await Deno.writeTextFile(join(root, "blocked/file.ts"), "denied");
  await Deno.chmod(join(root, "blocked"), 0);
  const adapter = adapterFor(root);
  try {
    for (
      const query of [
        "src/file.ts",
        join(root, "src/file.ts"),
        "./src/../src/file.ts",
      ]
    ) {
      const files = await requireCapability(adapter.capabilities, "files")
        .findFiles(
          "ses_files",
          query,
        );
      assert(files.some((file) => file.path === query && !file.directory));
      assert(!files.some((file) => file.path === "blocked/file.ts"));
    }
    await assertRejects(
      () =>
        mapPromptParts([{ kind: "text", text: "keep text" }, {
          kind: "file",
          source: "path",
          path: "blocked/file.ts",
        }], root),
      HarnessError,
      'Cannot read attachment "blocked/file.ts"',
    );
  } finally {
    await Deno.chmod(join(root, "blocked"), 0o700);
    await adapter.core.stop();
  }
});

test("mapped file filenames retain the relative path and optional canonical range", async () => {
  const root = await fixture();
  await Deno.mkdir(join(root, "src"));
  await Deno.writeTextFile(join(root, "src/file.ts"), "one\ntwo\nthree");
  const parts = await mapPromptParts([{
    kind: "file",
    source: "path",
    path: "./src/file.ts",
    range: { start: 3 },
  }], root);
  assertEquals(parts[0].type, "file");
  assertEquals(
    "filename" in parts[0] ? parts[0].filename : undefined,
    "src/file.ts#3",
  );
});
