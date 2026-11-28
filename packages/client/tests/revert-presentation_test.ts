// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  failureValue,
  type Feedback,
  RequestFailure,
  revertPresentation,
  type SessionRevertState,
} from "@otk/client";

for (const pending of ["restore", "redo", "revert", "undo", "code"] as const) {
  Deno.test(`rollback ${pending} retains its pending status when native request feedback starts`, () => {
    const state: SessionRevertState = { pending, key: "boundary" };
    const feedback: Feedback = {
      identity: "boundary",
      kind: "pending",
      text: "Native action",
    };
    const result = revertPresentation(state, feedback);
    assertEquals(result.state.pending, pending);
    assertEquals(
      result.feedback,
      undefined,
      "The generic pending copy yields to its explicit rollback owner",
    );
    assertEquals(state.pending, pending);
  });
}
Deno.test("unrelated request feedback is not suppressed by rollback state", () => {
  const state: SessionRevertState = { pending: "restore", key: "boundary" };
  const feedback: Feedback = {
    identity: "other",
    kind: "pending",
    text: "Other action",
  };
  const result = revertPresentation(state, feedback);
  assertEquals(result.state, state);
  assertEquals(result.feedback, feedback);
});
for (const outcome of ["rejected", "unknown"] as const) {
  Deno.test(`rollback ${outcome} preserves its single FP1 failure instead of generic pending`, () => {
    const cause = new RequestFailure({
      code: "native.request",
      diagnosticID: "failure",
      retry: "new-intent",
      facts: {
        actionLabel: "Restoring conversation",
        outcome,
        reason: "Native restore refused",
      },
    });
    const value = failureValue(cause);
    assert(value);
    const feedback: Feedback = { ...value, identity: "boundary" };
    const state: SessionRevertState = {
      key: "boundary",
      pending: "restore",
      failure: cause.failure,
      error: value,
    };
    const result = revertPresentation(state, feedback);
    assertEquals(result.feedback, undefined);
    assertEquals(result.state, state);
    assertEquals(result.state.error, value);
  });
}
