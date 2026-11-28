// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { catalogConsumer } from "../reuse/directory-catalogs-consumer.ts";
import { cfg } from "../support/config.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { nativeVersion } from "../support/native.ts";
import { OpencodeTest, waitFor } from "../support/opencode.ts";
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

async function inotifyWatches(): Promise<number> {
  // Deno intentionally reserves procfs for --allow-all; read only this test
  // process's accounting through the runner's existing subprocess permission.
  const result = await new Deno.Command("python3", {
    args: [
      "-c",
      `
import pathlib, sys
count = 0
for fd in pathlib.Path('/proc', sys.argv[1], 'fdinfo').iterdir():
    try:
        count += sum(line.startswith('inotify wd:') for line in fd.read_text().splitlines())
    except FileNotFoundError:
        pass
print(count)
`,
      String(Deno.pid),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
  return Number(new TextDecoder().decode(result.stdout));
}

test("file catalog caps inotify across ignored checkout trees and observes a tracked rename", async () => {
  if (Deno.build.os !== "linux") return; // Kernel accounting is Linux-specific.
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake);
  const settings = cfg();
  settings.harness.url = oc.url;
  settings.harness.db = oc.db;
  const adapter = catalogConsumer(settings);
  const leases: ReturnType<typeof adapter.catalogs.acquire>[] = [];
  try {
    const roots = [];
    const git = async (cwd: string, ...args: string[]) => {
      const result = await new Deno.Command("git", {
        cwd,
        args,
        stderr: "piped",
      }).output();
      assertEquals(result.code, 0, new TextDecoder().decode(result.stderr));
    };
    for (let n = 0; n < 4; n++) {
      const root = join(oc.root, `watch-checkout-${n}`);
      await Deno.mkdir(join(root, "src"), { recursive: true });
      await git(root, "init", "-q");
      await Deno.writeTextFile(
        join(root, ".gitignore"),
        "node_modules/\nbuild/\n",
      );
      await Deno.writeTextFile(join(root, "src/tracked.ts"), "export {};\n");
      await Deno.writeTextFile(join(root, "src/.gitignore"), "generated/\n");
      await git(root, "add", ".gitignore", "src/tracked.ts", "src/.gitignore");
      for (
        const tree of ["node_modules", ".git/objects", "build", "src/generated"]
      ) {
        for (let i = 0; i < 256; i++) {
          await Deno.mkdir(join(root, tree, `fixture-${i}`, "nested"), {
            recursive: true,
          });
        }
      }
      roots.push(root);
    }
    const baseline = await inotifyWatches(), perCheckout = [];
    let last = baseline;
    for (const root of roots) {
      const lease = adapter.catalogs.acquire(root);
      leases.push(lease);
      const files = await lease.get("files");
      assert(files.some(({ path }) => path === "src/tracked.ts"));
      const current = await inotifyWatches();
      perCheckout.push(current - last);
      last = current;
    }
    console.log(
      JSON.stringify({ baseline, perCheckout, total: last - baseline }),
    );
    assert(
      last - baseline <= 8,
      "four checkouts need only root and src watches",
    );
    await git(roots[0], "mv", "src/tracked.ts", "src/renamed.ts");
    const first = leases[0];
    await waitFor(
      () => first.snapshot().values.files?.value ?? [],
      (files) =>
        files.some(({ path }) => path === "src/renamed.ts") &&
        !files.some(({ path }) => path === "src/tracked.ts"),
    );
    for (const lease of leases) lease.release();
    await waitFor(inotifyWatches, (count) => count === baseline);
  } finally {
    for (const lease of leases) lease.release();
    await adapter.core.stop();
    await oc.stop();
    await fake.stop();
  }
});
