// SPDX-License-Identifier: LGPL-3.0-only
import {
  type ContentSession,
  type CreatedSessionReceipt,
  isSessionID,
  type RequestReceipts,
} from "@otk/protocol";
import { mappedReceipt, metadataReceipt } from "../requests/policies.ts";
import { object, sessionID, text } from "../ws/params.ts";

function session(value: unknown): CreatedSessionReceipt {
  const row = object(value);
  const id = text(row, "id")!;
  if (
    !isSessionID(id) || typeof row.archived !== "boolean" ||
    typeof row.title !== "string" || typeof row.projectID !== "string" ||
    !Number.isSafeInteger(row.timeCreated) ||
    !Number.isSafeInteger(row.timeUpdated) ||
    Number(row.timeCreated) < 0 || Number(row.timeUpdated) < 0 ||
    row.parentID !== undefined && !isSessionID(row.parentID)
  ) throw new TypeError("Invalid session metadata receipt");
  return {
    id,
    directory: text(row, "directory")!,
    title: row.title,
    projectID: row.projectID,
    archived: row.archived,
    timeCreated: Number(row.timeCreated),
    timeUpdated: Number(row.timeUpdated),
    ...(row.parentID === undefined ? {} : { parentID: String(row.parentID) }),
  };
}
const project = (value: ContentSession): CreatedSessionReceipt => ({
  id: value.id,
  directory: value.directory,
  title: value.title,
  projectID: value.projectID,
  archived: value.archived,
  timeCreated: value.time.created,
  timeUpdated: value.time.updated,
  ...(value.parentID ? { parentID: value.parentID } : {}),
});
const restore = (value: CreatedSessionReceipt): ContentSession => ({
  id: value.id,
  directory: value.directory,
  title: value.title,
  projectID: value.projectID,
  archived: value.archived,
  time: { created: value.timeCreated, updated: value.timeUpdated },
  ...(value.parentID ? { parentID: value.parentID } : {}),
});
export const createdReceipt = mappedReceipt(
  "session-created",
  session,
  project,
  restore,
);
export const renamedReceipt = mappedReceipt(
  "session-renamed",
  session,
  project,
  restore,
);
export const renameIntent = metadataReceipt(
  "session-rename-intent",
  (value) => {
    const row = object(value), id = sessionID(row)!;
    if (!isSessionID(id)) throw new TypeError("Invalid rename witness");
    return { sessionID: id, title: text(row, "title")! };
  },
);
function boundary(
  value: unknown,
): { sessionID: string; messageID: string | null } {
  const row = object(value), id = sessionID(row)!;
  if (
    !isSessionID(id) ||
    row.messageID !== null && typeof row.messageID !== "string"
  ) throw new TypeError("Invalid boundary receipt");
  return { sessionID: id, messageID: row.messageID as string | null };
}
export const boundaryReceipt = metadataReceipt("session-boundary", boundary);
export const boundaryIntent = metadataReceipt(
  "session-boundary-intent",
  boundary,
);
type CompletionKind = {
  [K in keyof RequestReceipts]: RequestReceipts[K] extends { completed: true }
    ? K
    : never;
}[keyof RequestReceipts];
export function completionReceipt<K extends CompletionKind>(kind: K) {
  const parse = (value: unknown): RequestReceipts[K] => {
    if (object(value).completed !== true) {
      throw new TypeError("Invalid completion receipt");
    }
    return { completed: true } as RequestReceipts[K];
  };
  return mappedReceipt<K, null>(
    kind,
    parse,
    () => parse({ completed: true }),
    () => null,
  );
}
