// SPDX-License-Identifier: LGPL-3.0-only
import { fromFileUrl } from "@std/path";
import type { HistoryEntry, PromptPart } from "@otk/protocol";
export interface StoredPart {
  id?: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  name?: string;
  filename?: string;
  mime?: string;
  url?: string;
  source?: {
    type?: string;
    clientName?: string;
    uri?: string;
    path?: string | null;
    text?: { value?: string };
  };
  state?: { input?: { command?: string } };
}
/** One mapper for SQL batches and API fallback. Inline uploads become references. */
export function historyEntry(
  messageID: string,
  time: number,
  parts: (StoredPart & { id: string; size?: number })[],
  command?: string,
): HistoryEntry | undefined {
  if (command !== undefined) {
    return {
      input: command,
      mode: "shell",
      parts: [{ kind: "text", text: command }],
      time,
    };
  }
  const mapped: PromptPart[] = [];
  for (const part of parts) {
    if (part.type === "text" && !part.synthetic) {
      mapped.push({ kind: "text", text: part.text || "" });
    } else if (part.type === "agent" && part.name) {
      mapped.push({ kind: "agent", name: part.name });
    } else if (part.type === "file") {
      const data = part.url?.match(/^data:([^;]*);base64,([\s\S]*)$/);
      const size = part.size ??
        (data
          ? data[2].length / 4 * 3 -
            (data[2].endsWith("==") ? 2 : data[2].endsWith("=") ? 1 : 0)
          : undefined);
      if (size !== undefined) {
        mapped.push({
          kind: "file",
          source: "history",
          name: part.filename || "attachment",
          mime: part.mime || "application/octet-stream",
          size,
          messageID,
          partID: part.id,
        });
      } else if (part.url) {
        if (
          part.source?.type === "resource" && part.source.clientName &&
          part.source.uri
        ) {
          mapped.push({
            kind: "file",
            source: "resource",
            name: part.filename || "resource",
            mime: part.mime || "text/plain",
            server: part.source.clientName,
            uri: part.source.uri,
            label: part.source.text?.value || `@${part.filename || "resource"}`,
          });
          continue;
        }
        const url = new URL(part.url);
        if (url.protocol !== "file:") continue;
        const start = Number(url.searchParams.get("start"));
        const end = url.searchParams.has("end")
          ? Number(url.searchParams.get("end"))
          : undefined;
        mapped.push({
          kind: "file",
          source: "path",
          path: part.source?.path || fromFileUrl(url),
          label: part.source?.text?.value ||
            `@${part.filename || fromFileUrl(url)}`,
          ...(Number.isInteger(start) && start > 0 &&
              (end === undefined || Number.isInteger(end) && end >= start)
            ? { range: { start, ...(end === undefined ? {} : { end }) } }
            : {}),
        });
      }
    }
  }
  const input = mapped.filter((part) => part.kind === "text").map((part) =>
    part.text
  ).join("\n");
  if (!input.trim() && !mapped.length) return;
  return { input, mode: "normal", parts: mapped, time };
}
