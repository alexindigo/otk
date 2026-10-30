// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { FailurePresenter, RequestFailure } from "../mod.ts";

Deno.test("failure presenter has safe fixed fallback and feature-owned contributions", () => {
  const presenter = new FailurePresenter();
  const failure = {
    code: "<html>/private/db SQL session.prompt",
    retry: "none" as const,
    diagnosticID: "opaque",
  };
  assertEquals(
    presenter.present(failure).text,
    "Could not finish this action. Try again",
  );
  assertEquals(
    new RequestFailure(failure).message,
    "Could not finish this action",
  );
  presenter.register(
    "credentials",
    () => ({ kind: "error", text: "Check your username and password" }),
  );
  assertEquals(
    presenter.present({ ...failure, code: "credentials" }).text,
    "Check your username and password",
  );
});
