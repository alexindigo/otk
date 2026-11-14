// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertNotEquals } from "@std/assert";
import {
  bootstrapRequestMetadata,
  createFailurePresenter,
  createSidecars,
  FailurePresenter,
  RequestTracker,
} from "@otk/client";
import { createRequestMetadata } from "@otk/protocol";

const base = {
  code: "fixture.rejected",
  retry: "new-intent" as const,
  diagnosticID: "action-label",
};

Deno.test("failure vocabulary includes every core and bootstrap action without displaying keys", () => {
  const presenter = createFailurePresenter(), core = createRequestMetadata();
  const entries = [
    ...core.methods().map((method) => [method, core.get(method)!.pending]),
    ...Object.entries(bootstrapRequestMetadata).map((
      [method, metadata],
    ) => [method, metadata.pending]),
  ];
  for (const [method, label] of entries) {
    const shown = presenter.describe({
      ...base,
      facts: { action: method, reason: "The request was refused" },
    });
    assertEquals(shown.failure?.action, label, method);
    assertEquals(shown.text.includes(method), false, method);
  }
});

Deno.test("unknown action identities are retained as facts but never used as public wording", () => {
  for (const presenter of [new FailurePresenter(), createFailurePresenter()]) {
    for (
      const action of [
        "plugin.private-action",
        "opaque-key",
        "an opaque key with spaces",
      ]
    ) {
      const shown = presenter.describe({
        ...base,
        facts: { action, reason: "The request was refused" },
      });
      assertEquals(shown.failure?.action, "The requested action");
      assertEquals(shown.failure?.value.facts?.action, action);
      assertEquals(shown.text.includes(action), false);
    }
  }
});

Deno.test("explicit feature-authored action wording is separate from opaque identity", () => {
  const facts = {
    action: "plugin.copy-private",
    actionLabel: "Copying source",
    reason: "Clipboard permission was refused",
  };
  for (const presenter of [new FailurePresenter(), createFailurePresenter()]) {
    const shown = presenter.describe({ ...base, facts });
    assertEquals(shown.failure?.action, "Copying source");
    assertEquals(shown.text.includes(facts.action), false);
  }
});

Deno.test("different unresolved action identities do not merge under the generic label", () => {
  const presenter = createFailurePresenter();
  const first = presenter.present({
    ...base,
    facts: { action: "plugin.first", reason: "Refused" },
  });
  const next = presenter.present({
    ...base,
    diagnosticID: "other",
    facts: { action: "plugin.second", reason: "Refused" },
  });
  assertNotEquals(first.identity, next.identity);
});

Deno.test("request capture uses its server label only for server-scoped failures", () => {
  const options = {
    send() {},
    sidecarId: "work",
    serverLabel: "Work server",
    sessionTitle: () => "Captured conversation",
  };
  const tracker = new RequestTracker(options);
  try {
    assertEquals(
      tracker.failureFacts("bootstrap.login", {}).target?.label,
      "Work server",
    );
    assertEquals(
      tracker.failureFacts("session.get", { sessionID: "tstv1-session" }).target
        ?.label,
      "Captured conversation",
    );
    assertEquals(
      tracker.failureFacts("projects.scan", { directory: "/work/project" })
        .target?.label,
      undefined,
    );
    assertEquals(
      tracker.failureFacts("bootstrap.login", {}, {
        facts: { target: { label: "Explicit target" } },
      }).target?.label,
      "Explicit target",
    );
  } finally {
    tracker.stop();
  }
});

Deno.test("sidecar composition supplies each captured server label for sign-in failures", () => {
  const values = new Map([[
    "otk.sidecars",
    JSON.stringify([{
      id: "work",
      baseUrl: "http://work.invalid",
      label: "Work server",
    }]),
  ]]);
  const sidecars = createSidecars(() => {}, {
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
  });
  try {
    for (
      const [id, label] of [["local", "This server"], ["work", "Work server"]]
    ) {
      const facts = sidecars.connection(id).requests.failureFacts(
        "bootstrap.login",
        {},
      );
      const shown = createFailurePresenter().describe({
        ...base,
        facts: { ...facts, reason: "Check your username and password" },
      });
      assertEquals(shown.failure?.heading, "Signing in failed");
      assertEquals(shown.failure?.target.label, label);
      assertEquals(shown.failure?.reason, "Check your username and password");
    }
  } finally {
    sidecars.stop();
  }
});
