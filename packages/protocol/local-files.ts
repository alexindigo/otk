// SPDX-License-Identifier: LGPL-3.0-only
import type { RequestMetadata } from "./request-metadata.ts";

export const MAX_STAT_PATHS = 64;
export const MAX_PATH_CHARS = 4096;
export const MAX_PREVIEW_TEXT_BYTES = 256 * 1024;
export const MAX_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024;
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
  & PreviewFile
  & (
    | { kind: "image"; mime: string; dataBase64: string }
    | { kind: "text"; text: string; truncated: boolean; lang?: string }
    | { kind: "none"; reason: "directory" | "binary" | "too-large" }
  );

export const localFileRequestMetadata = {
  "file.stat": { kind: "read", pending: "Checking files" },
  "file.preview": { kind: "read", pending: "Opening file" },
} satisfies Record<string, RequestMetadata>;

export interface LocalFileRpcMethods {
  "file.stat": {
    params: { sessionID: string; paths: string[] };
    result: FileFact[];
  };
  "file.preview": {
    params: { sessionID: string; path: string };
    result: FilePreview;
  };
}
