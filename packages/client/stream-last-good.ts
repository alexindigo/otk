// SPDX-License-Identifier: LGPL-3.0-only
import type { Block, Inline, Message, Part } from "@otk/protocol";
import { isAssistantTerminal } from "@otk/protocol";

type TextPart = Extract<Part, { kind: "text" | "reasoning" }>;
const textPart = (part?: Part): part is TextPart =>
  part?.kind === "text" || part?.kind === "reasoning";
const inlineLength = (values: readonly Inline[]): number =>
  values.reduce(
    (total, value) =>
      total + ("inline" in value
        ? inlineLength(value.inline)
        : "text" in value
        ? value.text.length
        : value.i === "image"
        ? value.alt.length
        : 1),
    0,
  );
const blockLength = (values: readonly Block[]): number =>
  values.reduce((total, value) => {
    switch (value.b) {
      case "paragraph":
      case "heading":
        return total + inlineLength(value.inline);
      case "code":
        return total + value.text.length;
      case "quote":
        return total + blockLength(value.blocks);
      case "list":
        return total + value.items.reduce(
          (n, item) => n + blockLength(item.blocks),
          0,
        );
      case "table":
        return total + [...value.header, ...value.rows.flat()].reduce(
          (n, cell) => n + inlineLength(cell),
          0,
        );
      case "rule":
        return total + 1;
    }
  }, 0);
const length = (part: TextPart) =>
  part.stream?.sourceLength ?? blockLength(part.blocks);

/** Preserve presentation, but adopt the incoming epoch's replacement fence. */
export function retainStreamPart(previous: Part | undefined, next: Part): Part {
  if (
    !textPart(previous) || !textPart(next) || previous.kind !== next.kind
  ) return next;
  const replacement = previous.stream?.mode === "replace" &&
    next.stream?.recovering;
  if (!replacement && length(next) >= length(previous)) return next;
  return {
    ...next,
    blocks: previous.blocks,
    ...(next.stream
      ? {
        stream: {
          ...next.stream,
          ...(replacement ? { mode: "replace" as const } : {}),
          sourceLength: length(previous),
        },
      }
      : {}),
  };
}

/** One canonical last-good body; removals and terminal values remain final. */
export function retainStreamMessage(
  previous: Message | undefined,
  next: Message,
): Message {
  if (
    previous?.id !== next.id || previous.sessionID !== next.sessionID ||
    previous.role !== "assistant" || next.role !== "assistant" ||
    isAssistantTerminal(previous) || isAssistantTerminal(next)
  ) return next;
  const known = new Map(previous.parts.map((part) => [part.id, part]));
  let changed = false;
  const parts = next.parts.map((part) => {
    const retained = retainStreamPart(known.get(part.id), part);
    changed ||= retained !== part;
    return retained;
  });
  const ids = new Set(parts.map((part) => part.id));
  for (const part of previous.parts) {
    if (textPart(part) && !ids.has(part.id)) {
      parts.push(part);
      changed = true;
    }
  }
  return changed ? { ...next, parts } : next;
}
