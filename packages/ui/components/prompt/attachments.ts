// SPDX-License-Identifier: LGPL-3.0-only
import { MAX_UPLOAD_BYTES, type PromptPart } from "@otk/protocol";
import { RequestFailure } from "@otk/client";
export async function upload(
  file: File,
): Promise<Extract<PromptPart, { source: "upload" }>> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new RequestFailure({
      code: "attachment.upload-size",
      retry: "new-intent",
      diagnosticID: crypto.randomUUID(),
    });
  }
  const data = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < data.length; i += 8192) {
    binary += String.fromCharCode(...data.subarray(i, i + 8192));
  }
  return {
    kind: "file",
    source: "upload",
    name: file.name || "attachment",
    mime: file.type || "application/octet-stream",
    dataBase64: btoa(binary),
  };
}
export function serverPath(text: string): string | undefined {
  const value = text.trim().replace(/^['"]|['"]$/g, "");
  if (!value || /[\n\r]/.test(value) || /^https?:/.test(value)) return;
  if (value.startsWith("file://")) {
    try {
      new URL(value);
      return value;
    } catch {
      return;
    }
  }
  return value;
}
