// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { emptyContent, reduce } from "@otk/client";

Deno.test("buffered older error observations cannot regress an identified current snapshot", () => {
  const current = {
    ...emptyContent(),
    error: "New native detail",
    errorState: {
      revision: 20,
      observations: [{
        id: "native",
        source: "event" as const,
        message: "New native detail",
      }],
    },
  };
  const older = {
    op: "session.error" as const,
    error: "Older HTTP diagnostic",
    errorState: {
      revision: 19,
      observations: [{
        id: "http",
        source: "http" as const,
        message: "Older HTTP diagnostic",
      }],
    },
  };
  assertEquals(reduce(current, older), current);
  const sameVersion = {
    ...older,
    errorState: { ...older.errorState, revision: 20 },
  };
  assertEquals(reduce(current, sameVersion), current);
});
Deno.test("newer observed error state and lifecycle clearing replace only their own prior revision", () => {
  const prior = {
    ...emptyContent(),
    error: "Prior error",
    errorState: {
      revision: 1,
      observations: [{
        id: "old",
        source: "http" as const,
        message: "Prior error",
      }],
    },
  };
  const next = {
    op: "session.error" as const,
    error: "Current native detail",
    errorState: {
      revision: 2,
      observations: [{
        id: "next",
        source: "event" as const,
        message: "Current native detail",
      }],
    },
  };
  const advanced = reduce(prior, next);
  assertEquals(advanced.error, "Current native detail");
  assertEquals(Reflect.get(advanced, "errorState"), next.errorState);
  const clear = {
    op: "session.error" as const,
    errorState: { revision: 3, observations: [] },
  };
  const cleared = reduce(advanced, clear);
  assertEquals(cleared.error, undefined);
  assertEquals(Reflect.get(cleared, "errorState"), clear.errorState);
  assertEquals(reduce(cleared, next), cleared);
});
