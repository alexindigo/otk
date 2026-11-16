// SPDX-License-Identifier: LGPL-3.0-only
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
} from "@std/assert";
import {
  commandFailureFacts,
  createFailurePresenter,
  failureNote,
  failureValue,
  FeedbackFailure,
  notificationFailure,
  RequestFailure,
  RequestReleased,
} from "@otk/client";

const failure = {
  code: "consumer.refused",
  retry: "new-intent" as const,
  diagnosticID: "command-label",
};

Deno.test("command failure facts snapshot public wording separately from private identity", () => {
  const command = { id: "consumer.private", title: "Copy captured source" };
  const facts = commandFailureFacts(command);
  command.id = "consumer.replacement";
  command.title = "Replacement action";
  assertEquals(facts, {
    action: "consumer.private",
    actionLabel: "Copy captured source",
  });
  const shown = createFailurePresenter().describe({ ...failure, facts });
  assertEquals(shown.failure?.action, "Copy captured source");
  assertEquals(shown.text.includes("consumer.private"), false);
});

Deno.test("missing public command wording never falls back to an identity", () => {
  for (const title of [undefined, "", "   "]) {
    const facts = commandFailureFacts({ id: "consumer.private", title });
    const shown = createFailurePresenter().describe({ ...failure, facts });
    assertEquals(shown.failure?.action, "The requested action");
    assertEquals(shown.text.includes("consumer.private"), false);
  }
});

Deno.test("equal command labels retain separate unknown grouping identities", () => {
  const presenter = createFailurePresenter();
  const first = presenter.present({
    ...failure,
    facts: commandFailureFacts({ id: "consumer.first", title: "Copy source" }),
  });
  const second = presenter.present({
    ...failure,
    facts: commandFailureFacts({ id: "consumer.second", title: "Copy source" }),
  });
  assertEquals(first.failure?.action, second.failure?.action);
  assertNotEquals(first.identity, second.identity);
});

Deno.test("command surface context cannot replace originating failure facts", () => {
  const origin = {
    action: "consumer.origin",
    actionLabel: "Original operation",
    target: { label: "Original target" },
    reason: "Original refusal",
    recovery: "Original next step",
  };
  const cause = new RequestFailure({ ...failure, facts: origin });
  const context = {
    ...commandFailureFacts({ id: "consumer.surface", title: "Surface action" }),
    target: { label: "Surface target" },
  };
  const shown = failureValue(cause, context);
  assert(shown);
  assertEquals(shown.failure?.value.facts?.action, origin.action);
  assertEquals(shown.failure?.action, origin.actionLabel);
  assertEquals(shown.failure?.target.label, origin.target.label);
  assertEquals(shown.failure?.reason, origin.reason);
  assertEquals(shown.failure?.recovery, origin.recovery);
  const note = notificationFailure(failureNote(cause, context)!);
  assertEquals(note?.value.facts?.action, origin.action);
  assertEquals(note?.action, origin.actionLabel);
  assertEquals(note?.target.label, origin.target.label);
});

Deno.test("command context preserves owned feedback and silent releases", () => {
  const context = commandFailureFacts({
    id: "consumer.surface",
    title: "Surface action",
  });
  const owned = createFailurePresenter().describe({
    ...failure,
    facts: { actionLabel: "Owned operation" },
  });
  assertStrictEquals(failureValue(owned, context), owned);
  assertStrictEquals(failureValue(new FeedbackFailure(owned), context), owned);
  assertEquals(failureValue(new RequestReleased(), context), "");
  assertEquals(failureNote(new RequestReleased(), context), undefined);
});
