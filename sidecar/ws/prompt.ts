// SPDX-License-Identifier: LGPL-3.0-only
import type { PromptPart } from "../../protocol/rpc.ts";
import { HarnessError } from "../adapter/types.ts";
import { object, text } from "./rpc.ts";
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export function promptParts(value: unknown): PromptPart[] {
  if (!Array.isArray(value) || !value.length) {
    throw new HarnessError("params", "parts required");
  }
  return value.map((value) => {
    const p = object(value);
    if (p.kind === "text") {
      return { kind: "text", text: text(p, "text", true) ?? "" };
    }
    if (p.kind === "agent") return { kind: "agent", name: text(p, "name")! };
    if (p.kind === "file" && p.source === "upload") {
      const dataBase64 = text(p, "dataBase64", true) ?? "";
      if (
        dataBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(dataBase64) ||
        /=[^=]/.test(dataBase64) || /={3}/.test(dataBase64)
      ) throw new HarnessError("params", "Invalid upload base64");
      if (
        dataBase64.length / 4 * 3 -
            (dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0) >
          MAX_UPLOAD_BYTES
      ) throw new HarnessError("params", "Upload exceeds 20 MiB");
      const mime = text(p, "mime")!;
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) {
        throw new HarnessError("params", "Invalid upload MIME type");
      }
      return {
        kind: "file",
        source: "upload",
        name: text(p, "name")!,
        mime,
        dataBase64,
      };
    }
    if (p.kind === "file" && p.source === "path") {
      let range: { start: number; end?: number } | undefined;
      if (p.range !== undefined) {
        const r = object(p.range);
        if (
          !Number.isInteger(r.start) || Number(r.start) < 1 ||
          (r.end !== undefined &&
            (!Number.isInteger(r.end) || Number(r.end) < Number(r.start)))
        ) throw new HarnessError("params", "Invalid file line range");
        range = {
          start: Number(r.start),
          ...(r.end === undefined ? {} : { end: Number(r.end) }),
        };
      }
      return {
        kind: "file",
        source: "path",
        path: text(p, "path")!,
        ...(range ? { range } : {}),
      };
    }
    if (p.kind === "file" && p.source === "resource") {
      return {
        kind: "file",
        source: "resource",
        name: text(p, "name")!,
        mime: text(p, "mime")!,
        uri: text(p, "uri")!,
        server: text(p, "server")!,
      };
    }
    throw new HarnessError("params", "Invalid prompt part");
  });
}
