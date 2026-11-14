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
  const title = presenter.present(failure);
  assertEquals({
    kind: title.kind,
    text: title.failure?.reason,
    field: title.field,
  }, {
    kind: "error",
    text: "Use a session title of 1–200 characters",
    field: "title",
  });
  assertEquals(
    (() => {
      const shown = presenter.present({
        ...failure,
        code: "attachment.upload-size",
      });
      return {
        kind: shown.kind,
        text: shown.failure?.reason,
        field: shown.field,
      };
    })(),
    {
      kind: "error",
      text: "Each upload must be 20 MiB or smaller",
      field: undefined,
    },
  );
});
