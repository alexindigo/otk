// SPDX-License-Identifier: LGPL-3.0-only
/** Immutable per-upload product limit; aggregate admission is operator policy. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export interface AttachmentPolicy {
  concurrency: number;
  maxrefs: number;
  maxbytes: number;
}
export function uploadSize(dataBase64: string): number {
  return dataBase64.length / 4 * 3 -
    (dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0);
}
