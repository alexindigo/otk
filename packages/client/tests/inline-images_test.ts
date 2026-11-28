// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  imageFactsLine,
  imageReason,
  imageSource,
  inlineImageUrl,
} from "../inline-images.ts";

Deno.test("image source classification reuses POSIX path semantics and keeps remote URLs", () => {
  for (
    const [raw, path] of [
      ["/home/u/a.png", "/home/u/a.png"],
      ["~/a.png", "~/a.png"],
      ["./a.png", "./a.png"],
      ["shots/a.png", "shots/a.png"],
      ["file:///a.png", "/a.png"],
      ["a.png:5", "a.png"],
    ]
  ) {
    assertEquals(imageSource(raw), { kind: "local", mention: { raw, path } });
    assertEquals(imageSource(raw, "win32"), undefined);
  }
  for (
    const raw of ["file://host/a.png", "javascript:x", "//example.test/p.png"]
  ) {
    assertEquals(imageSource(raw), undefined);
  }
  assertEquals(imageSource("https://x/a.png"), {
    kind: "web",
    href: "https://x/a.png",
  });
  assertEquals(imageSource("data:image/png;base64,AA"), {
    kind: "data",
    href: "data:image/png;base64,AA",
  });
  assertEquals(
    inlineImageUrl(new URL("https://x/otk/api/"), "s&?", "~/a b.png"),
    "https://x/otk/api/inline-image?session=s%26%3F&path=%7E%2Fa+b.png",
  );
});

Deno.test("one image presenter vocabulary covers every service and load failure", () => {
  assertEquals(
    imageReason({ path: "p", status: "unavailable", reason: "outside" }),
    "Outside allowed folders",
  );
  assertEquals(
    imageReason({ path: "p", status: "unavailable", reason: "denied" }),
    "Not allowed",
  );
  assertEquals(
    imageReason({ path: "p", status: "unavailable", reason: "missing" }),
    "Not found",
  );
  assertEquals(
    imageReason({ path: "p", status: "unavailable", reason: "not-image" }),
    "Not an image",
  );
  assertEquals(
    imageReason({
      path: "p",
      status: "unavailable",
      reason: "too-large",
      size: 2_097_152,
      limit: 1_048_576,
    }),
    "Too large to show (2 MB, limit 1 MB)",
  );
  assertEquals(
    imageReason({
      path: "p",
      status: "unavailable",
      reason: "too-many-pixels",
      width: 12000,
      height: 9000,
    }),
    "Too many pixels (12000 x 9000)",
  );
  assertEquals(
    imageReason({ status: "unavailable", reason: "load-failed" }),
    "Couldn't load",
  );
  assertEquals(
    imageReason({ status: "unavailable", reason: "unsupported" }),
    "This server can't show local images",
  );
  assertEquals(
    imageFactsLine({
      path: "p",
      resolved: "/p",
      name: "p",
      status: "image",
      mime: "image/png",
      width: 320,
      height: 200,
      size: 1024,
    }),
    "PNG image · 320 x 200 · 1 KB",
  );
});
