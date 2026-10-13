// SPDX-License-Identifier: LGPL-3.0-only
import type {
  ContentOp,
  FileDiff,
  Message,
  PermissionRequest,
  QuestionRequest,
  RevertInfo,
  Todo,
} from "../../../protocol/content.ts";
export interface ContentState {
  messages: Message[];
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  todos: Todo[];
  diffs: FileDiff[];
  revert: RevertInfo | null;
  error?: string;
}
export function emptyContent(): ContentState {
  return {
    messages: [],
    permissions: [],
    questions: [],
    todos: [],
    diffs: [],
    revert: null,
  };
}
export function reduce(state: ContentState, op: ContentOp): ContentState {
  if (op.op === "session.error") return { ...state, error: op.error };
  if (op.op === "question.upsert") {
    return {
      ...state,
      questions: [
        ...state.questions.filter((q) => q.id !== op.request.id),
        op.request,
      ].sort((a, b) => a.id.localeCompare(b.id)),
    };
  }
  if (op.op === "question.remove") {
    return {
      ...state,
      questions: state.questions.filter((q) => q.id !== op.requestID),
    };
  }
  if (op.op === "session.revert") {
    return {
      ...state,
      revert: op.messageID && op.messageCount
        ? {
          messageID: op.messageID,
          messageCount: op.messageCount,
          files: op.files,
        }
        : null,
    };
  }
  if (op.op === "permission.upsert") {
    const permissions = [...state.permissions];
    const at = permissions.findIndex((request) => request.id === op.request.id);
    if (at < 0) permissions.push(op.request);
    else permissions[at] = op.request;
    return {
      ...state,
      permissions: permissions.sort((a, b) => a.time - b.time),
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
    if (
      previous?.role === "assistant" && previous.time.completed !== undefined &&
      op.message.role === "assistant" && op.message.time.completed === undefined
    ) return state;
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
        if (op.part.kind === "text" || op.part.kind === "reasoning") {
          const previous = message.parts[index];
          if (
            op.part.streamVersion !== undefined &&
            ((message.role === "assistant" &&
              message.time.completed !== undefined) ||
              ((previous?.kind === "text" || previous?.kind === "reasoning") &&
                (previous.streamVersion || 0) > op.part.streamVersion))
          ) return message;
        }
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
            ? (op.streamVersion !== undefined &&
                ((message.role === "assistant" &&
                  message.time.completed !== undefined) ||
                  (part.streamVersion || 0) > op.streamVersion))
              ? part
              : {
                ...part,
                blocks: [...part.blocks.slice(0, op.from), ...op.blocks],
                ...(op.streamVersion === undefined
                  ? {}
                  : { streamVersion: op.streamVersion }),
              }
            : part
        ),
      };
    }),
  };
}
