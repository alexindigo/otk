// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { HarnessError } from "@otk/harness";
import {
  MAX_PATH_CHARS,
  MAX_PREVIEW_IMAGE_BYTES,
  MAX_PREVIEW_TEXT_BYTES,
  MAX_STAT_PATHS,
  OperationFailure,
} from "@otk/protocol";
import { LocalFiles } from "../../../core/files/local-files.ts";

async function tree(
  test: (
    tree: { root: string; home: string; work: string; files: LocalFiles },
  ) => Promise<void>,
) {
  const root = await Deno.makeTempDir();
  const home = join(root, "home"),
    work = join(root, "work"),
    deny = join(home, "state");
  try {
    await Deno.mkdir(work);
    await Deno.mkdir(deny, { recursive: true });
    await test({
      root,
      home,
      work,
      files: new LocalFiles({ home, deny: [deny] }),
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("local file facts check roots, symlinks, credentials and regular files", () =>
  tree(async ({ root, home, work, files }) => {
    const write = (path: string) => Deno.writeTextFile(path, "hello");
    for (const name of ["a.txt", ".envrc", "x.pem", "state/private.txt"]) {
      await write(join(home, name));
    }
    await Deno.mkdir(join(home, ".ssh"));
    await write(join(home, ".ssh/id_ed25519"));
    await write(join(home, ".ssh/known_hosts"));
    await write(join(work, "relative.txt"));
    await Deno.writeFile(join(work, "blob"), new Uint8Array([0]));
    await write(join(root, "outside.txt"));
    await Deno.mkdir(join(root, "work-neighbor"));
    await write(join(root, "work-neighbor/a.txt"));
    await Deno.symlink(join(root, "outside.txt"), join(work, "away.txt"));
    await Deno.symlink(join(work, "relative.txt"), join(root, "into.txt"));
    await Deno.symlink(join(home, ".envrc"), join(work, "harmless.txt"));
    if (Deno.build.os !== "windows") {
      assert(
        (await new Deno.Command("mkfifo", { args: [join(work, "fifo")] })
          .output()).success,
      );
      const start = performance.now();
      assertEquals((await files.stat(work, ["fifo"]))[0].status, "absent");
      assert(performance.now() - start < 1000);
    }
    const paths = [
      "~/a.txt",
      "relative.txt",
      toFileUrl(join(work, "relative.txt")).href,
      "file://localhost" + join(work, "relative.txt"),
      "../into.txt",
      ".",
      "blob",
      "../../etc/passwd",
      "file://remote/x",
      "away.txt",
      "../work-neighbor/a.txt",
      "~/.envrc",
      "~/.ssh/id_ed25519",
      "~/.ssh/known_hosts",
      "~/x.pem",
      "~/state/private.txt",
      "harmless.txt",
    ];
    const facts = await files.stat(work, paths);
    assertEquals(facts.map((fact) => fact.path), paths);
    assertEquals(facts.map((fact) => fact.status), [
      "file",
      "file",
      "file",
      "file",
      "file",
      "directory",
      "file",
      ...Array(10).fill("absent"),
    ]);
    assertEquals(facts[0], {
      path: paths[0],
      status: "file",
      resolved: join(home, "a.txt"),
      size: 5,
      preview: "text",
    });
    assert(facts[1].status === "file");
    assertEquals(facts[2], {
      ...facts[1],
      path: paths[2],
      resolved: fromFileUrl(paths[2]),
    });
    assertEquals(facts[4], {
      ...facts[1],
      path: paths[4],
      resolved: join(root, "into.txt"),
    });
    assertEquals(facts[5], {
      path: ".",
      status: "directory",
      resolved: work,
      size: 0,
      preview: "none",
    });
    assertEquals(facts[6], {
      path: "blob",
      status: "file",
      resolved: join(work, "blob"),
      size: 1,
      preview: "none",
    });
  }));

Deno.test("file requests reject invalid input and honor cancellation", () =>
  tree(async ({ work, files }) => {
    assertEquals(
      (await files.stat(work, Array(MAX_STAT_PATHS).fill("missing"))).length,
      MAX_STAT_PATHS,
    );
    await assertRejects(
      () => files.stat(work, Array(MAX_STAT_PATHS + 1).fill("missing")),
      HarnessError,
    );
    for (
      const bad of [
        "",
        "a\0z",
        "b\x1f",
        "c\u0085",
        "x".repeat(MAX_PATH_CHARS + 1),
      ]
    ) {
      await assertRejects(() => files.stat(work, [bad]), HarnessError);
      await assertRejects(() => files.preview(work, bad), HarnessError);
    }
    await assertRejects(
      () => files.stat(work, ["."], AbortSignal.abort()),
      DOMException,
      "aborted",
    );
  }));

Deno.test("previews cap bytes, trim split UTF-8 and verify image MIME", () =>
  tree(async ({ work, files }) => {
    const prefix = "x".repeat(MAX_PREVIEW_TEXT_BYTES - 1);
    const text = prefix + "🍏\n";
    await Deno.writeTextFile(join(work, "file.ts"), text);
    await Deno.writeTextFile(join(work, "pretend.png"), "plain text");
    await Deno.writeTextFile(
      join(work, "a.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    await Deno.writeFile(
      join(work, "a.png"),
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await Deno.writeTextFile(join(work, "large.png"), "x");
    await Deno.truncate(join(work, "large.png"), MAX_PREVIEW_IMAGE_BYTES + 1);
    await Deno.writeFile(join(work, "binary.txt"), new Uint8Array([255]));
    assertEquals(await files.preview(work, "file.ts"), {
      kind: "text",
      name: "file.ts",
      resolved: join(work, "file.ts"),
      size: new TextEncoder().encode(text).length,
      text: prefix,
      truncated: true,
      lang: "ts",
    });
    const png = await files.preview(work, "a.png"),
      svg = await files.preview(work, "a.svg");
    assertEquals(png.kind === "image" && png.mime, "image/png");
    assertEquals(svg.kind === "image" && svg.mime, "image/svg+xml");
    assertEquals((await files.preview(work, "pretend.png")).kind, "text");
    const large = await files.preview(work, "large.png");
    assertEquals(large.kind === "none" && large.reason, "too-large");
    const binary = await files.preview(work, "binary.txt");
    assertEquals(binary.kind === "none" && binary.reason, "binary");
    const directory = await files.preview(work, ".");
    assertEquals(directory.kind === "none" && directory.reason, "directory");
    const failure = await assertRejects(
      () => files.preview(work, "gone"),
      OperationFailure,
    );
    assertEquals(failure.code, "file-unavailable");
  }));
