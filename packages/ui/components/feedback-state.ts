// SPDX-License-Identifier: LGPL-3.0-only
import type { Feedback } from "@otk/client";

/** Feedback semantics and paint are one binding, shared by every surface. */
export function feedbackState(input: { feedback?: Feedback; class?: string }): {
  class: string;
  role: "alert" | "status";
  "aria-hidden"?: "true";
  "aria-atomic": "true";
} {
  const value = input.feedback;
  return {
    class: [
      input.class,
      value ? "is-visible" : "",
      value?.kind === "connection"
        ? "is-reconnecting"
        : value
        ? `is-${value.kind}`
        : "",
    ].filter(Boolean).join(" "),
    role: value?.kind === "error" ? "alert" : "status",
    "aria-hidden": value ? undefined : "true",
    "aria-atomic": "true",
  };
}
