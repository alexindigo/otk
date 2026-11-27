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
const imageLimits = { maxbytes: 1024, maxpixels: 40_000_000 };
const testPng = (width = 320, height = 200, size = 33) => {
  const png = new Uint8Array(size);
  png.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(png.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return png;
};

Deno.test("inline image roots guard both lexical and canonical containment", () =>
  tree(async ({ files, root, home, work }) => {
    const roots = [work, join(home, "TemporaryFiles/p")];
    await Deno.mkdir(roots[1], { recursive: true });
    await Deno.writeFile(join(roots[1], "image.png"), testPng());
    await Deno.writeFile(join(work, "image.png"), testPng());
    await Deno.writeFile(join(root, "outside.png"), testPng());
    await Deno.symlink(join(root, "outside.png"), join(work, "outbound.png"));
    await Deno.symlink(join(work, "image.png"), join(root, "inbound.png"));
    const realPath = Deno.realPath;
    const touched: string[] = [];
    Deno.realPath = (path) => {
      touched.push(String(path));
      return realPath(path);
    };
    try {
      assertEquals(
        await files.imageFacts(roots, work, ["../inbound.png"], imageLimits),
        [{ path: "../inbound.png", status: "unavailable", reason: "outside" }],
      );
      assertEquals(touched, []);
    } finally {
      Deno.realPath = realPath;
    }
    assertEquals(
      (await files.imageFacts(roots, work, ["outbound.png"], imageLimits))[0],
      { path: "outbound.png", status: "unavailable", reason: "outside" },
    );
    for (const path of ["image.png", "~/TemporaryFiles/p/image.png"]) {
      const [fact] = await files.imageFacts(roots, work, [path], imageLimits);
      assert(fact.status === "image");
      assertEquals([fact.width, fact.height, fact.mime], [
        320,
        200,
        "image/png",
      ]);
    }
  }));

Deno.test("inline image policy conceals credential paths and dotfiles even through aliases", () =>
  tree(async ({ files, home, work }) => {
    await Deno.mkdir(join(work, ".private"));
    const paths = [
      ".envrc",
      ".private/photo.png",
      "id_ed25519",
      "~/.photo.png",
      "~/state/photo.png",
    ];
    for (const path of paths) {
      await Deno.writeFile(
        path.startsWith("~/") ? join(home, path.slice(2)) : join(work, path),
        testPng(),
      );
    }
    await Deno.symlink(
      join(work, ".private/photo.png"),
      join(work, "alias.png"),
    );
    paths.push("alias.png");
    assertEquals(
      await files.imageFacts([home, work], work, paths, imageLimits),
      paths.map((path) => ({ path, status: "unavailable", reason: "denied" })),
    );
  }));

Deno.test("inline images sniff MIME, refuse declarations and apply byte and pixel limits", () =>
  tree(async ({ files, work }) => {
    await Deno.writeFile(join(work, "misnamed.jpg"), testPng());
    await Deno.writeTextFile(join(work, "wrong.png"), "not an image");
    await Deno.writeTextFile(join(work, "wrong.svg"), "<html><svg/></html>");
    await Deno.writeTextFile(
      join(work, "valid.txt"),
      '\uFEFF<?xml version="1.0"?> <!-- comment --> <svg viewBox="0 0 40 20"><title>Drawing</title></svg>',
    );
    await Deno.writeTextFile(join(work, "doctype.svg"), "<!DOCTYPE svg><svg/>");
    await Deno.writeTextFile(
      join(work, "entity.svg"),
      '<svg><!ENTITY sample "value"></svg>',
    );
    await Deno.writeFile(join(work, "max.png"), testPng(320, 200, 1024));
    await Deno.writeFile(join(work, "above.png"), testPng(320, 200, 1025));
    await Deno.writeFile(join(work, "pixels.png"), testPng(10_000, 10_000));
    const paths = [
      "misnamed.jpg",
      "wrong.png",
      "wrong.svg",
      "valid.txt",
      "doctype.svg",
      "entity.svg",
      "max.png",
      "above.png",
      "pixels.png",
    ];
    const states = (await files.imageFacts([work], work, paths, imageLimits))
      .map((f) =>
        f.status === "image"
          ? [f.mime, f.width, f.height, f.size]
          : f.status === "unavailable"
          ? [f.reason, f.limit]
          : [f.status]
      );
    assertEquals(states, [
      ["image/png", 320, 200, 33],
      ["not-image", undefined],
      ["not-image", undefined],
      [
        "image/svg+xml",
        40,
        20,
        (await Deno.stat(join(work, "valid.txt"))).size,
      ],
      ["not-image", undefined],
      ["not-image", undefined],
      ["image/png", 320, 200, 1024],
      ["too-large", 1024],
      ["too-many-pixels", 40_000_000],
    ]);
  }));

Deno.test("inline-image read refuses a regular file whose identity changed before open", () =>
  tree(async ({ files, work }) => {
    const target = join(work, "target.png");
    const replacement = join(work, "replacement.png");
    await Deno.writeFile(target, testPng());
    await Deno.writeFile(replacement, testPng(60, 40));
    const stat = Deno.stat;
    let swapped = false;
    Deno.stat = async (path) => {
      const info = await stat(path);
      if (path === target && !swapped) {
        await Deno.rename(replacement, target);
        swapped = true;
      }
      return info;
    };
    try {
      assertEquals(
        await files.imageBytes([work], work, "target.png", imageLimits),
        {
          fact: {
            path: "target.png",
            status: "unavailable",
            reason: "missing",
          },
        },
      );
      assert(swapped);
    } finally {
      Deno.stat = stat;
    }
  }));

Deno.test("inline dimensions use raster headers and oriented JPEG dimensions", () =>
  tree(async ({ files, work }) => {
    const gif = Uint8Array.from([
      71,
      73,
      70,
      56,
      57,
      97,
      36,
      0,
      27,
      0,
      0,
      0,
      0,
    ]);
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe1,
      0,
      34,
      69,
      120,
      105,
      102,
      0,
      0,
      73,
      73,
      42,
      0,
      8,
      0,
      0,
      0,
      1,
      0,
      0x12,
      1,
      3,
      0,
      1,
      0,
      0,
      0,
      6,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0xff,
      0xc0,
      0,
      11,
      8,
      0,
      27,
      0,
      36,
      1,
      1,
      0x11,
      0,
      0xff,
      0xd9,
    ]);
    const webp = (kind: string) => {
      const bytes = new Uint8Array(30);
      bytes.set(new TextEncoder().encode("RIFF\0\0\0\0WEBP" + kind));
      return bytes;
    };
    const lossy = webp("VP8 ");
    lossy.set([0x9d, 1, 0x2a, 36, 0, 27, 0], 23);
    const lossless = webp("VP8L");
    lossless[20] = 0x2f;
    new DataView(lossless.buffer).setUint32(21, 35 | (26 << 14), true);
    const extended = webp("VP8X");
    extended[24] = 35;
    extended[27] = 26;
    const fixtures = [["gif", gif], ["jpeg", jpeg], ["lossy", lossy], [
      "lossless",
      lossless,
    ], ["extended", extended]] as const;
    for (const [name, bytes] of fixtures) {
      await Deno.writeFile(join(work, name), bytes);
    }
    const facts = await files.imageFacts(
      [work],
      work,
      fixtures.map(([name]) => name),
      imageLimits,
    );
    assertEquals(
      facts.map((fact) =>
        fact.status === "image" ? [fact.mime, fact.width, fact.height] : fact
      ),
      [
        ["image/gif", 36, 27],
        ["image/jpeg", 27, 36],
        ["image/webp", 36, 27],
        ["image/webp", 36, 27],
        ["image/webp", 36, 27],
      ],
    );
  }));
