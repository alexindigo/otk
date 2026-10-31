// SPDX-License-Identifier: LGPL-3.0-only
import { MAX_UPLOAD_BYTES, uploadSize } from "@otk/protocol";
import { RequestFailure } from "./failures.ts";
import type {
  AttachmentPolicy,
  HistoryAttachment,
  HistoryAttachmentRef,
  PromptPart,
} from "@otk/protocol";
/** One all-or-fail preparation owner for every prompt submission surface. */
export async function prepareAttachments(
  parts: PromptPart[],
  origin: string,
  policy: AttachmentPolicy,
  load: (
    origin: string,
    refs: HistoryAttachmentRef[],
  ) => Promise<HistoryAttachment[]>,
): Promise<PromptPart[]> {
  const files = parts.filter((part) => part.kind === "file");
  let bytes = 0;
  if (files.length > policy.maxrefs) throw new Error("Too many attachments");
  for (const file of files) {
    const size = file.source === "history"
      ? file.size
      : file.source === "upload"
      ? uploadSize(file.dataBase64)
      : 0;
    if (size > MAX_UPLOAD_BYTES) {
      throw new RequestFailure({
        code: "attachment.upload-size",
        retry: "new-intent",
        diagnosticID: crypto.randomUUID(),
      });
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Attachment exceeds the upload limit");
    }
    bytes += size;
  }
  if (bytes > policy.maxbytes) {
    throw new Error("Combined attachments exceed the upload limit");
  }
  const groups = new Map<string, Map<string, HistoryAttachmentRef>>();
  const key = (ref: HistoryAttachmentRef) =>
    JSON.stringify([ref.messageID, ref.partID]);
  for (const part of files) {
    if (part.source === "history") {
      const server = part.sidecarID || origin,
        refs = groups.get(server) ?? new Map();
      refs.set(key(part), { messageID: part.messageID, partID: part.partID });
      groups.set(server, refs);
    }
  }
  const jobs = [...groups],
    results = new Map<string, Map<string, HistoryAttachment["part"]>>();
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(policy.concurrency, jobs.length) },
      async () => {
        while (next < jobs.length) {
          const [server, refs] = jobs[next++],
            values = await load(server, [...refs.values()]);
          const found = new Map<string, HistoryAttachment["part"]>();
          for (const item of values) {
            if (!refs.has(key(item.ref)) || found.has(key(item.ref))) {
              throw new Error(
                "Attachment source returned an invalid reference",
              );
            }
            found.set(key(item.ref), item.part);
          }
          if (found.size !== refs.size) {
            throw new Error(
              "Attachment source did not return every attachment",
            );
          }
          results.set(server, found);
        }
      },
    ),
  );
  const result = parts.map((part) =>
    part.kind === "file" && part.source === "history"
      ? results.get(part.sidecarID || origin)!.get(key(part))!
      : part
  );
  const actual = result.flatMap((part) =>
    part.kind === "file" && part.source === "upload"
      ? [uploadSize(part.dataBase64)]
      : []
  );
  if (actual.some((size) => size > MAX_UPLOAD_BYTES)) {
    throw new RequestFailure({
      code: "attachment.upload-size",
      retry: "new-intent",
      diagnosticID: crypto.randomUUID(),
    });
  }
  if (actual.reduce((a, b) => a + b, 0) > policy.maxbytes) {
    throw new Error("Combined attachments exceed the upload limit");
  }
  return result;
}
