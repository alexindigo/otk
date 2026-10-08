// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentOp,
  FileDiff,
  Message,
  PermissionRequest,
  Todo,
} from "../../../protocol/content.ts";
export interface ContentState {
  messages: Message[];
  permissions: PermissionRequest[];
  todos: Todo[];
  diffs: FileDiff[];
}
export function emptyContent(): ContentState {
  return { messages: [], permissions: [], todos: [], diffs: [] };
}
export function reduce(state: ContentState, op: ContentOp): ContentState {
  if (op.op === "permission.upsert") {
    return {
      ...state,
      permissions: [
        ...state.permissions.filter((p) => p.id !== op.request.id),
        op.request,
      ].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)),
    };
  }
  if (op.op === "permission.remove") {
    return {
      ...state,
      permissions: state.permissions.filter((p) => p.id !== op.requestID),
    };
  }
  if (op.op === "todo.set") return { ...state, todos: op.items };
  if (op.op === "diff.set") return { ...state, diffs: op.files };
  if (op.op === "message.remove") {
    return {
      ...state,
      messages: state.messages.filter((m) => m.id !== op.messageID),
    };
  }
  if (op.op === "message.upsert") {
    const previous = state.messages.find((m) => m.id === op.message.id);
    // Live message.upsert is a header update; parts are delivered independently.
    const message = {
      ...op.message,
      parts: op.message.parts.length ? op.message.parts : previous?.parts ?? [],
    };
    return {
      ...state,
      messages: [...state.messages.filter((m) => m.id !== message.id), message]
        .sort((a, b) =>
          a.time.created - b.time.created || a.id.localeCompare(b.id)
        ),
    };
  }
  return {
    ...state,
    messages: state.messages.map((message) => {
      if (message.id !== op.messageID) return message;
      if (op.op === "part.upsert") {
        const index = message.parts.findIndex((part) => part.id === op.part.id);
        const parts = [...message.parts];
        if (index < 0) parts.push(op.part);
        else parts[index] = op.part;
        return { ...message, parts };
      }
      if (op.op === "part.remove") {
        return {
          ...message,
          parts: message.parts.filter((p) => p.id !== op.partID),
        };
      }
      return {
        ...message,
        parts: message.parts.map((part) =>
          part.id === op.partID &&
            (part.kind === "text" || part.kind === "reasoning")
            ? {
              ...part,
              blocks: [...part.blocks.slice(0, op.from), ...op.blocks],
            }
            : part
        ),
      };
    }),
  };
}
