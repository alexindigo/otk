// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { feedbackState } from "../components/feedback-state.ts";

Deno.test("feedback binding keeps empty, pending, connection and failure semantics with their state classes", () => {
  for (
    const kind of [undefined, "pending", "connection", "error", "info"] as const
  ) {
    const value = kind ? { kind, text: "A safe fact" } : undefined;
    const bound = feedbackState({ feedback: value, class: "consumer-slot" });
    assertEquals(bound.role, kind === "error" ? "alert" : "status");
    assertEquals(bound["aria-hidden"], kind ? undefined : "true");
    assertEquals(bound["aria-atomic"], "true");
    assertEquals(bound.class.includes("is-visible"), !!kind);
    assertEquals(
      bound.class.includes("is-reconnecting"),
      kind === "connection",
    );
    assertEquals(bound.class.includes("is-error"), kind === "error");
  }
});
