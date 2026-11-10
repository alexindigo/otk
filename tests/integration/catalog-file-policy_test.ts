// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { catalogConsumer } from "../reuse/directory-catalogs-consumer.ts";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { nativeVersion } from "../support/native.ts";
import { OpencodeTest } from "../support/opencode.ts";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests(
  "V1 /file ignored flags and V1 catalog consumer wire calls",
  ["tests/integration/v2-catalogs_test.ts#OC2C1"],
);

test("file catalog excludes native ignores and never requests Git metadata subtrees", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake, {}, {
    async prepare(oc) {
      await Deno.writeTextFile(
        join(oc.directory, ".gitignore"),
        ".opencode/\nignored/\nignored.txt\n",
      );
      for (
        const path of [
          "ignored/deep",
          "visible/.git/objects",
          "visible/worktree",
          "visible/legit.git",
          ".github",
        ]
      ) await Deno.mkdir(join(oc.directory, path), { recursive: true });
      for (
        const path of [
          "ignored.txt",
          "ignored/deep/private.txt",
          ".git/objects/catalog-probe",
          "visible/.git/objects/catalog-probe",
          "visible/worktree/.git",
          "visible/worktree/source.ts",
          "visible/legit.git/source.ts",
          ".github/workflow.yml",
        ]
      ) await Deno.writeTextFile(join(oc.directory, path), "catalog probe");
    },
  });
  const calls: URL[] = [];
  const settings = cfg();
  settings.harness.url = oc.url;
  settings.harness.db = oc.db;
  const adapter = catalogConsumer(settings, (input, options) => {
    calls.push(new URL(String(input)));
    return fetch(input, options);
  });
  const lease = adapter.catalogs.acquire(oc.directory);
  try {
    const native: Record<string, Record<string, unknown>[]> = {};
    for (const path of ["", "visible", "visible/worktree"]) {
      native[path] = await oc.request(`/file?path=${encodeURIComponent(path)}`);
    }
    console.log(JSON.stringify({ nativeVersion, native }));
    await Deno.writeTextFile(
      join(oc.root, "catalog-file-policy-native.json"),
      JSON.stringify({ nativeVersion, native }, null, 2),
    );
    assertEquals(
      native[""].find((row) => row.name === "ignored")?.ignored,
      true,
    );
    assertEquals(
      native[""].find((row) => row.name === "ignored.txt")?.ignored,
      true,
    );
    assert(native[""].some((row) => row.name === ".git"));
    const files = await lease.get("files");
    await lease.refresh();
    assertEquals(await lease.get("files"), files);
    const paths = files.map((file) => file.path);
    for (
      const path of [
        "README.md",
        "visible/worktree/source.ts",
        "visible/legit.git/source.ts",
        ".github/workflow.yml",
      ]
    ) assert(paths.includes(path), `Visible candidate missing: ${path}`);
    assertEquals(
      paths.filter((path) =>
        path.split("/").includes(".git") || path === "ignored.txt" ||
        path === "ignored" || path.startsWith("ignored/")
      ),
      [],
      "Git metadata and native ignores must never reach completion consumers",
    );
    assertEquals(
      calls.filter((url) => url.pathname === "/file").map((url) =>
        url.searchParams.get("path") ?? ""
      ).filter((path) =>
        path.split("/").includes(".git") || path === "ignored" ||
        path.startsWith("ignored/") || path === ".opencode"
      ),
      [],
      "Excluded directory entries must be pruned before scheduling descendants",
    );
  } finally {
    lease.release();
    await adapter.core.stop();
    await oc.stop();
    await fake.stop();
  }
});
