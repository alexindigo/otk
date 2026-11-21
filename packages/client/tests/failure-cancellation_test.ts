// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { failureFeedback, FailurePresenter } from "../failures.ts";

Deno.test("explicit lifetime cancellation is not a failed action", () => {
  assertEquals(
    failureFeedback(
      new DOMException("Send canceled", "AbortError"),
      new FailurePresenter(),
    ),
    undefined,
  );
});
