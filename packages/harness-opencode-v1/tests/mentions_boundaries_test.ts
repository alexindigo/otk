// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../../../tests/support/resources.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { cfg, fixture } from "../../../tests/support/config.ts";
import { OpencodeV1Adapter as Opencode1Adapter } from "../mod.ts";
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
    assertEquals(url.pathname, "/file");
    return (async () => {
      const path = url.searchParams.get("path") ?? "";
      const values = [];
      for await (const item of Deno.readDir(join(root, path))) {
        values.push({
          name: item.name,
          path: join(path, item.name),
          absolute: join(root, path, item.name),
          type: item.isDirectory ? "directory" : "file",
          ignored: false,
        });
      }
      return Response.json(values);
    })();
  });
}

test("unreadable discovery subtrees make the catalog unavailable and explicit prompt files reject", async () => {
  const root = await fixture();
  await Deno.mkdir(join(root, "src"));
  await Deno.mkdir(join(root, "blocked"));
  await Deno.writeTextFile(join(root, "src/file.ts"), "readable");
  await Deno.writeTextFile(join(root, "blocked/file.ts"), "denied");
  await Deno.chmod(join(root, "blocked"), 0);
  const adapter = adapterFor(root);
  try {
    await assertRejects(() =>
      requireCapability(adapter.capabilities, "files").findFiles(
        "opcv1-ses_files",
        "src/file.ts",
      )
    );
    await assertRejects(
      () =>
        mapPromptParts([{
          kind: "file",
          source: "path",
          path: "blocked/file.ts",
        }], root),
      HarnessError,
      'Cannot read attachment "blocked/file.ts"',
    );
    await Deno.chmod(join(root, "blocked"), 0o700);
    for (
      const query of [
        "src/file.ts",
        join(root, "src/file.ts"),
        "./src/../src/file.ts",
      ]
    ) {
      const files = await requireCapability(adapter.capabilities, "files")
        .findFiles(
          "opcv1-ses_files",
          query,
        );
      assert(files.some((file) => file.path === query && !file.directory));
    }
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
