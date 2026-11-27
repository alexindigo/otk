// SPDX-License-Identifier: LGPL-3.0-only
import {
  INLINE_IMAGE_ROUTE,
  type InlineImageFact,
  type PathSemantics,
} from "@otk/protocol";
import { hrefPath, type PathMention } from "./file-paths.ts";
import { formatBytes, metaList } from "./format.ts";

export type ImageSource =
  | { kind: "local"; mention: PathMention }
  | { kind: "web" | "data"; href: string };
export type ClientImageFailure = {
  status: "unavailable";
  reason: "load-failed" | "unsupported";
};
type Unavailable =
  | Extract<InlineImageFact, { status: "unavailable" }>
  | ClientImageFailure;

export function imageSource(
  src: string,
  style?: PathSemantics["style"],
): ImageSource | undefined {
  if (/^data:image\//i.test(src)) return { kind: "data", href: src };
  const mention = hrefPath(src, style);
  if (mention) {
    return { kind: "local", mention: { raw: mention.raw, path: mention.path } };
  }
  try {
    const url = new URL(src);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return { kind: "web", href: src };
    }
  } catch {
    // No implicit browser-relative URL for an unrecognized source.
  }
}

export function inlineImageUrl(
  api: URL,
  sessionID: string,
  path: string,
): string {
  const url = new URL(INLINE_IMAGE_ROUTE, api);
  url.searchParams.set("session", sessionID);
  url.searchParams.set("path", path);
  return url.href;
}

export function imageReason(fact: Unavailable): string {
  switch (fact.reason) {
    case "outside":
      return "Outside allowed folders";
    case "denied":
      return "Not allowed";
    case "missing":
      return "Not found";
    case "not-image":
      return "Not an image";
    case "too-large":
      return `Too large to show (${formatBytes(fact.size!)}, limit ${
        formatBytes(fact.limit!)
      })`;
    case "too-many-pixels":
      return `Too many pixels (${fact.width} x ${fact.height})`;
    case "load-failed":
      return "Couldn't load";
    case "unsupported":
      return "This server can't show local images";
  }
}

export function imageFactsLine(
  fact: Extract<InlineImageFact, { status: "image" }>,
): string {
  const kind = {
    "image/png": "PNG",
    "image/jpeg": "JPEG",
    "image/gif": "GIF",
    "image/webp": "WebP",
    "image/svg+xml": "SVG",
  }[fact.mime];
  return metaList([
    `${kind} image`,
    `${fact.width} x ${fact.height}`,
    formatBytes(fact.size),
  ]);
}
