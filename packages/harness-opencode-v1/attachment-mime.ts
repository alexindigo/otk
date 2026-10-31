// SPDX-License-Identifier: LGPL-3.0-only
/** Bounded signature/text classification, shared by every native path send. */
export function attachmentMime(bytes: Uint8Array, complete = true): string {
  const starts = (...values: number[]) =>
    values.every((value, i) => bytes[i] === value);
  const ascii = (offset: number, text: string) =>
    [...text].every((value, i) => bytes[offset + i] === value.charCodeAt(0));
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (starts(255, 216, 255)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "%PDF-")) return "application/pdf";
  if (!bytes.includes(0)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes, {
        stream: !complete,
      });
      return "text/plain";
    } catch { /* Unreported binary MIME stays unknown. */ }
  }
  return "application/octet-stream";
}
