// SPDX-License-Identifier: LGPL-3.0-only
import type { FileMatch } from "../rpc.ts";
export interface FilesCapability {
  findFiles(sessionID: string, query: string): Promise<FileMatch[]>;
}
export interface FilesCapabilities {
  files: FilesCapability;
}
export const legacyFilesCapabilities: readonly (keyof FilesCapabilities)[] = [
  "files",
];
