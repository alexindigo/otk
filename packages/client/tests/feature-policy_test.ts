// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createFailurePresenter } from "../failure-features.ts";

Deno.test("feature policy failures explain the actual title and upload bounds", () => {
  const presenter = createFailurePresenter();
  const failure = {
    code: "session.title",
    retry: "new-intent" as const,
    diagnosticID: "test",
  };
  assertEquals(presenter.present(failure), {
    kind: "error",
    text: "Use a session title of 1–200 characters",
    field: "title",
  });
  assertEquals(
    presenter.present({ ...failure, code: "attachment.upload-size" }),
    {
      kind: "error",
      text: "Each upload must be 20 MiB or smaller",
      field: undefined,
    },
  );
});
