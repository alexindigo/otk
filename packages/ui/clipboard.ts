// SPDX-License-Identifier: LGPL-3.0-only
import { RequestFailure } from "@otk/client";
import { randomID } from "@otk/protocol";

/** One browser write boundary. Rejections are structured FP1 failures so every
 * existing action surface can display action, target, reason and next step. */
export async function copyText(value: string): Promise<void> {
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
  try {
    host.append(field);
    field.select();
    if (document.execCommand("copy")) return;
  } catch (error) {
    cause = error;
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
  const failure = new RequestFailure({
    code: "clipboard.unavailable",
    retry: "new-intent",
    diagnosticID: randomID(),
    facts: {
      actionLabel: "Copy",
      target: { label: "Selected source" },
      reason: "The browser refused access to the clipboard.",
      recovery: "Select the source text and press Ctrl+C (Cmd+C on macOS).",
    },
  });
  failure.cause = cause;
  throw failure;
}
