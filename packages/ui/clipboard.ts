// SPDX-License-Identifier: LGPL-3.0-only
import { RequestFailure } from "@otk/client";
import { randomID } from "@otk/protocol";
import { nativeTextField } from "./keyboard/ownership.ts";

const source = "[data-copy-source]";
const proseBlock = /^(?:P|DIV|H[1-6]|PRE|LI|BLOCKQUOTE|TR)$/;

/** Copy projected inline values as source, in both selection copy paths. */
export function sourceSelectionText(selection: Selection): string | undefined {
  const ranges = Array.from(
    { length: selection.rangeCount },
    (_, i) => selection.getRangeAt(i).cloneRange(),
  ).filter((range) => !range.collapsed);
  const containingElement = (node: Node) =>
    node instanceof Element ? node : node.parentElement;
  if (
    !ranges.some((range) => {
      const common = containingElement(range.commonAncestorContainer);
      return common?.closest(source) ||
        [...(common?.querySelectorAll(source) ?? [])]
          .some((node) => range.intersectsNode(node));
    })
  ) return;
  const fragments = ranges.map((range) => {
    const containingSource = (node: Node) =>
      containingElement(node)?.closest(source);
    const start = containingSource(range.startContainer);
    const end = containingSource(range.endContainer);
    if (start) range.setStartBefore(start);
    if (end) range.setEndAfter(end);
    return range.cloneContents();
  });
  const text = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node instanceof HTMLElement) {
      if (node.dataset.copySource !== undefined) return node.dataset.copySource;
      if (node.tagName === "BR") return "\n";
      if (node.hidden || node.getAttribute("aria-hidden") === "true") return "";
    }
    const children = Array.from(node.childNodes, text).join("");
    return children && node instanceof Element && proseBlock.test(node.tagName)
      ? `${children}\n`
      : children;
  };
  return fragments.map(text).join("\n").replace(/\n$/, "");
}

export function bindSourceSelectionCopy(): () => void {
  const copy = (event: ClipboardEvent) => {
    const selection = document.getSelection();
    if (
      event.defaultPrevented || !event.clipboardData || !selection ||
      nativeTextField(event.target)
    ) return;
    const text = sourceSelectionText(selection);
    if (text === undefined) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };
  document.addEventListener("copy", copy);
  return () => document.removeEventListener("copy", copy);
}

/** Optional shortcut read. Native paste remains available when unavailable or
 * refused, including on plain HTTP where no programmatic read API exists. */
export async function readText(): Promise<string | undefined> {
  if (!globalThis.isSecureContext || !navigator.clipboard?.readText) return;
  try {
    return await navigator.clipboard.readText();
  } catch {
    return undefined;
  }
}

/** One browser write boundary. Rejections are structured FP1 failures so every
 * existing action surface can display action, target, reason and next step. */
export async function copyText(
  value: string,
  context?: { actionLabel: string; target: string; recovery: string },
): Promise<void> {
  let cause: unknown;
  if (globalThis.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch (error) {
      cause = error;
    }
  }
  const focused = document.activeElement;
  const selection = document.getSelection();
  const direction = selection?.rangeCount === 1 && selection.anchorNode &&
      selection.focusNode
    ? {
      anchor: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focus: selection.focusNode,
      focusOffset: selection.focusOffset,
    }
    : undefined;
  const ranges = selection
    ? Array.from(
      { length: selection.rangeCount },
      (_, i) => selection.getRangeAt(i).cloneRange(),
    )
    : [];
  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.setAttribute("aria-label", "Copy source");
  // Native modal focus containment requires the temporary field in that modal.
  const host = focused?.closest("dialog[open]") ?? document.body;
  field.style.cssText = "position:fixed;inset:0;opacity:0;pointer-events:none";
  let copied = false;
  const write = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    // Textarea values normalize CR/CRLF. The source, not that value, is copied.
    event.clipboardData.setData("text/plain", value);
    event.preventDefault();
    copied = true;
  };
  field.addEventListener("copy", write);
  try {
    host.append(field);
    field.select();
    if (document.execCommand("copy") && copied) return;
  } catch (error) {
    cause = error;
  } finally {
    field.removeEventListener("copy", write);
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      if (direction) {
        selection.setBaseAndExtent(
          direction.anchor,
          direction.anchorOffset,
          direction.focus,
          direction.focusOffset,
        );
      } else {
        for (const range of ranges) selection.addRange(range);
      }
    }
  }
  const failure = new RequestFailure({
    code: "clipboard.unavailable",
    retry: "new-intent",
    diagnosticID: randomID(),
    facts: {
      actionLabel: context?.actionLabel ?? "Copy",
      target: { label: context?.target ?? "Selected source" },
      reason: "The browser refused access to the clipboard.",
      recovery: context?.recovery ??
        "Select the source text and press Ctrl+C (Cmd+C on macOS).",
    },
  });
  failure.cause = cause;
  throw failure;
}
