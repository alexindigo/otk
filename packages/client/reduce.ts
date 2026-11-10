// SPDX-License-Identifier: LGPL-3.0-only
import {
  sessionErrorMessage,
  type SessionErrorState,
  withHelperProgress,
} from "@otk/protocol";
import { retainStreamMessage, retainStreamPart } from "./stream-last-good.ts";
import type {
  ContentOp,
  FileDiff,
  Message,
  PermissionRequest,
  QuestionRequest,
  RevertInfo,
  Todo,
} from "@otk/protocol";
export interface ContentState {
  messages: Message[];
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  forms?: import("@otk/protocol").FormRequest[];
  todos: Todo[];
  diffs: FileDiff[];
  revert: RevertInfo | null;
  error?: string;
  errorState?: SessionErrorState;
  recovering?: {
    messageID: string;
    partID: string;
    generation: number;
    state?: "recovering" | "unavailable";
  }[];
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
/** Copy non-body state without evaluating a canonical owner's lazy message getter. */
export function contentMetadata(
  state: ContentState,
): Omit<ContentState, "messages"> {
  const { messages: _messages, ...metadata } = Object.getOwnPropertyDescriptors(
    state,
  );
  return Object.defineProperties({}, metadata) as Omit<
    ContentState,
    "messages"
  >;
}
function output(message: Message, lastOutput?: number): Message {
  return message.role === "assistant" && message.time.completed === undefined &&
      lastOutput !== undefined
    ? {
      ...message,
      time: {
        ...message.time,
        lastOutput: Math.max(message.time.lastOutput || 0, lastOutput),
      },
    }
    : message;
}
/** Keyed owners supply the already-indexed part slot; pure consumers can omit it. */
export function reduceMessage(
  previous: Message | undefined,
  op: ContentOp,
  slot?: number,
): Message | undefined {
  if (op.op === "message.remove") return undefined;
  if (op.op === "message.upsert") {
    if (
      previous?.role === "assistant" && previous.time.completed !== undefined &&
      op.message.role === "assistant" && op.message.time.completed === undefined
    ) return previous;
    const message: Message = {
      ...op.message,
      parts: op.message.parts.length ? op.message.parts : previous?.parts ?? [],
    };
    if (message.role === "assistant" && op.message.role === "assistant") {
      message.time = {
        ...op.message.time,
        lastOutput: op.message.time.completed !== undefined
          ? op.message.time.lastOutput
          : Math.max(
            op.message.time.lastOutput || op.message.time.created,
            previous?.role === "assistant" ? previous.time.lastOutput || 0 : 0,
          ),
      };
    }
    return retainStreamMessage(previous, message);
  }
  if (!previous) return;
  if (op.op === "message.clock") {
    return previous.role === "assistant"
      ? { ...previous, time: { ...previous.time, lastOutput: op.lastOutput } }
      : previous;
  }
  if (op.op === "task.progress") {
    const index = slot ??
      previous.parts.findIndex((part) => part.id === op.partID);
    const part = previous.parts[index];
    if (!part) return previous;
    const next = withHelperProgress(part, op.childSessionID, op.summary);
    if (next === part) return previous;
    const parts = [...previous.parts];
    parts[index] = next;
    return { ...previous, parts };
  }
  if (
    op.op !== "part.upsert" && op.op !== "part.remove" &&
    op.op !== "part.blocks"
  ) return previous;
  const id = op.op === "part.upsert" ? op.part.id : op.partID;
  const index = slot ?? previous.parts.findIndex((part) => part.id === id);
  const target = previous.parts[index];
  if (op.op === "part.remove") {
    if (index < 0) return previous;
    const parts = [...previous.parts];
    parts.splice(index, 1);
    return { ...previous, parts };
  }
  if (op.op === "part.upsert") {
    if (
      (op.part.kind === "text" || op.part.kind === "reasoning") &&
      op.part.stream &&
      ((previous.role === "assistant" &&
        previous.time.completed !== undefined) ||
        ((target?.kind === "text" || target?.kind === "reasoning") &&
          target.stream?.epoch === op.part.stream.epoch &&
          (target.stream.generation > op.part.stream.generation ||
            (target.stream.generation === op.part.stream.generation &&
              target.stream.version > op.part.stream.version))))
    ) return previous;
    const parts = [...previous.parts];
    const part = previous.role === "assistant" &&
        previous.time.completed === undefined &&
        (op.part.kind === "text" || op.part.kind === "reasoning") &&
        (op.part.stream?.mode === "replace" || op.part.stream?.recovering)
      ? retainStreamPart(target, op.part)
      : op.part;
    if (index < 0) parts.push(part);
    else parts[index] = part;
    return output({ ...previous, parts }, op.lastOutput);
  }
  if (previous.role === "assistant" && previous.time.completed !== undefined) {
    return previous;
  }
  if (
    (target?.kind === "text" || target?.kind === "reasoning") &&
    target.stream?.mode === "replace" && op.stream.recovering
  ) return previous;
  if (
    (target?.kind === "text" || target?.kind === "reasoning") &&
    target.stream?.epoch === op.stream.epoch &&
    target.stream.generation === op.stream.generation &&
    target.stream.version >= op.stream.version
  ) return previous;
  if (
    (target?.kind !== "text" && target?.kind !== "reasoning") ||
    !target.stream || target.stream.mode !== "appendable" ||
    target.stream.epoch !== op.stream.epoch ||
    target.stream.generation !== op.stream.generation ||
    target.stream.version !== op.baseVersion
  ) throw new Error("stream-gap");
  const parts = [...previous.parts];
  parts[index] = {
    ...target,
    blocks: [...target.blocks.slice(0, op.from), ...op.blocks],
    stream: op.stream,
  };
  return output({ ...previous, parts }, op.lastOutput);
}
export function reduceRecovery<T extends Omit<ContentState, "messages">>(
  state: T,
  op: ContentOp,
  sourceAccepted = false,
): T {
  if (op.op === "stream.reconcile") return state;
  if (op.op === "stream.recovery") {
    const previous = state.recovering?.find((p) =>
      p.messageID === op.messageID && p.partID === op.partID
    );
    if (previous && previous.generation > op.generation) return state;
    const recovering = (state.recovering ?? []).filter((p) =>
      p.messageID !== op.messageID || p.partID !== op.partID
    );
    if (op.state !== "ready") {
      recovering.push({
        messageID: op.messageID,
        partID: op.partID,
        generation: op.generation,
        state: op.state,
      });
    }
    return { ...state, recovering };
  }
  if (state.recovering?.length) {
    const recovering = state.recovering.filter((p) => {
      if (op.op === "message.remove") return p.messageID !== op.messageID;
      if (op.op === "part.remove") {
        return p.messageID !== op.messageID || p.partID !== op.partID;
      }
      if (
        op.op !== "part.upsert" || !sourceAccepted ||
        p.messageID !== op.messageID ||
        p.partID !== op.part.id
      ) return true;
      return (op.part.kind === "text" || op.part.kind === "reasoning") &&
        (op.part.stream?.mode === "replace" || op.part.stream?.recovering);
    });
    if (recovering.length !== state.recovering.length) {
      return { ...state, recovering };
    }
  }
  return state;
}
export function reduce(state: ContentState, op: ContentOp): ContentState {
  state = reduceRecovery(state, op);
  if (op.op === "stream.reconcile" || op.op === "stream.recovery") return state;
  if (op.op === "agent.colors") {
    return {
      ...state,
      messages: state.messages.map((message) => ({
        ...message,
        agentColor: message.agent === undefined
          ? undefined
          : op.colors[message.agent],
      })),
    };
  }
  if (op.op === "session.error") {
    if (op.errorState) {
      if (op.errorState.revision <= (state.errorState?.revision ?? -1)) {
        return state;
      }
      return {
        ...state,
        errorState: op.errorState,
        error: sessionErrorMessage(op.errorState),
      };
    }
    return state.errorState ? state : { ...state, error: op.error };
  }
  if (op.op === "form.upsert") {
    return {
      ...state,
      forms: [
        ...(state.forms ?? []).filter((f) => f.id !== op.request.id),
        op.request,
      ],
    };
  }
  if (op.op === "form.remove") {
    return {
      ...state,
      forms: (state.forms ?? []).filter((f) => f.id !== op.requestID),
    };
  }
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
          ...(op.prompts === undefined ? {} : { prompts: op.prompts }),
          ...(op.prompt === undefined ? {} : { prompt: op.prompt }),
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
      recovering: state.recovering?.filter((p) => p.messageID !== op.messageID),
      messages: state.messages.filter((m) => m.id !== op.messageID),
    };
  }
  if (op.op === "message.upsert") {
    const message = reduceMessage(
      state.messages.find((m) => m.id === op.message.id),
      op,
    )!;
    return {
      ...state,
      messages: [...state.messages.filter((m) => m.id !== message.id), message]
        .sort((a, b) =>
          a.time.created - b.time.created || a.id.localeCompare(b.id)
        ),
    };
  }
  const messages = state.messages.map((message) =>
    message.id === op.messageID ? reduceMessage(message, op)! : message
  );
  return {
    ...reduceRecovery(
      state,
      op,
      messages.some((message, index) => message !== state.messages[index]),
    ),
    messages,
  };
}
