// SPDX-License-Identifier: LGPL-3.0-only
import type { FileMatch } from "../rpc.ts";
import { arrayCatalogCodec } from "./arrays.ts";
export interface CatalogFile extends FileMatch {
  canonicalPath: string;
}
export interface FileCatalogKinds {
  files: CatalogFile[];
}
export interface FileChunkKinds {
  files: CatalogFile;
}
export const filesCatalogCodec = arrayCatalogCodec<"files">();
