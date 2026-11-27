// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "./request-metadata.ts";

export const MAX_STAT_PATHS = 64;
export const MAX_PATH_CHARS = 4096;
export const MAX_PREVIEW_TEXT_BYTES = 256 * 1024;
export const MAX_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024;
export const INLINE_IMAGE_ROUTE = "inline-image";
export const INLINE_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
] as const;
export type InlineImageType = typeof INLINE_IMAGE_TYPES[number];
export type InlineImageReason =
  | "outside"
  | "denied"
  | "missing"
  | "not-image"
  | "too-large"
  | "too-many-pixels";
export type InlineImageFact =
  | {
    path: string;
    status: "image";
    resolved: string;
    name: string;
    mime: InlineImageType;
    size: number;
    width: number;
    height: number;
  }
  | {
    path: string;
    status: "unavailable";
    reason: InlineImageReason;
    size?: number;
    limit?: number;
    width?: number;
    height?: number;
  }
  | { path: string; status: "unknown" };
export type FilePreviewClass = "image" | "text" | "none";
export type FileFactFound = {
  path: string;
  status: "file" | "directory";
  resolved: string;
  size: number;
  preview: FilePreviewClass;
};
export type FileFact = FileFactFound | {
  path: string;
  status: "absent" | "unknown";
};
type PreviewFile = { name: string; resolved: string; size: number };
export type FilePreview =
  | { kind: "unavailable"; reason: Extract<InlineImageReason, "outside"> }
  | PreviewFile
    & (
      | { kind: "image"; mime: string; dataBase64: string }
      | { kind: "text"; text: string; truncated: boolean; lang?: string }
      | { kind: "none"; reason: "directory" | "binary" | "too-large" }
    );

export const localFileRequestMetadata = {
  "file.stat": { kind: "read", pending: "Checking files" },
  "file.preview": { kind: "read", pending: "Opening file" },
  "file.images": { kind: "read", pending: "Checking images" },
} satisfies Record<string, RequestMetadata>;

export interface LocalFileRpcMethods {
  "file.images": {
    params: { sessionID: string; paths: string[] };
    result: InlineImageFact[];
  };
  "file.stat": {
    params: { sessionID: string; paths: string[] };
    result: FileFact[];
  };
  "file.preview": {
    params: { sessionID: string; path: string };
    result: FilePreview;
  };
}
