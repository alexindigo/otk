// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { FailurePresenter, RequestFailure } from "../mod.ts";

Deno.test("failure presenter derives the complete contract and optional enrichment", () => {
  const presenter = new FailurePresenter();
  const failure = {
    code: "<html>/private/db SQL session.prompt",
    retry: "none" as const,
    diagnosticID: "opaque",
  };
  assertEquals(
    presenter.present(failure).failure?.reason,
    "No publishable failure reason is available",
  );
  assertEquals(
    new RequestFailure(failure).message,
    "Request rejected",
  );
  presenter.register(
    "credentials",
    () => ({ kind: "error", text: "Check your username and password" }),
  );
  assertEquals(
    presenter.present({ ...failure, code: "credentials" }).failure?.reason,
    "Check your username and password",
  );
});
