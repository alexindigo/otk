// SPDX-License-Identifier: LGPL-3.0-only
import { RequestFailure } from "@otk/client";
import { randomID } from "@otk/protocol";

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
