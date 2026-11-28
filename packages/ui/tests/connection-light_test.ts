// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import type { ServerContinuity } from "@otk/client";
import {
  CONNECTION_STATES,
  connectionFeedback,
  type ConnectionInput,
  connectionLabel,
  connectionState,
} from "../components/connection-light.ts";

Deno.test("the footer offers the same Reload for update, outage and refusal", () => {
  let reloads = 0;
  const cases: [ServerContinuity, string][] = [
    [{ kind: "updated" }, "OTK was updated"],
    [{ kind: "unreachable", since: 1 }, "Can't reach OTK"],
    [{
      kind: "away",
      since: 1,
      refused: "Still unreachable. Page not reloaded.",
    }, "Still unreachable. Page not reloaded."],
  ];
  for (const [continuity, text] of cases) {
    const state = {
      label: "This server",
      id: "local",
      status: "reconnecting",
      harness: "connected",
      continuity,
    } as const;
    const feedback = connectionFeedback(state, () => reloads++);
    assertEquals(feedback?.text, text);
    assertEquals(feedback?.action?.label, "Reload");
    feedback?.action?.run();
  }
  assertEquals(reloads, cases.length);
});

const healthy: ConnectionInput = {
  label: "This server",
  status: "connected",
  harness: "connected",
};
Deno.test("connection notice presents reconnecting as information and clears when connected", () => {
  assertEquals(connectionFeedback({ ...healthy, status: "reconnecting" }), {
    kind: "info",
    text: "Reconnecting to OTK...",
  });
  assertEquals(connectionFeedback(healthy), undefined);
  const invalid = connectionFeedback({
    ...healthy,
    status: "reconnecting",
    error: "Invalid OTK request reference",
  });
  assertEquals(invalid?.kind, "error");
  assertEquals(invalid?.failure?.reason, "Invalid OTK request reference");
  assertEquals(invalid?.failure?.target.label, "This server");
});
Deno.test("connection health requires both links and gives failures precedence over a stale connected status", () => {
  assertEquals(connectionState(healthy), "connected");
  assertEquals(connectionState(), "disconnected");
  for (const status of ["connecting", "reconnecting"] as const) {
    assertEquals(connectionState({ ...healthy, status }), status);
    assertEquals(connectionState({ ...healthy, harness: status }), status);
  }
  for (
    const status of [
      "login required",
      "setup required",
    ] as const
  ) {
    assertEquals(connectionState({ ...healthy, status }), "error");
  }
  assertEquals(
    connectionState({ ...healthy, error: "Lost transport" }),
    "error",
  );
  assertEquals(
    connectionState({ ...healthy, status: "reconnecting", error: "Refused" }),
    "error",
  );
  assertEquals(
    connectionState({
      ...healthy,
      status: "connecting",
      harness: "reconnecting",
    }),
    "reconnecting",
  );
});
Deno.test("connection descriptions retain transport, agent link and error details independently of session labels", () => {
  assertEquals(
    connectionLabel(healthy),
    "This server: connected; agent service connected",
  );
  assertEquals(
    connectionLabel({ ...healthy, harness: "reconnecting", error: "Closed" }),
    "This server: connected; agent service reconnecting; Closed",
  );
  assertEquals(connectionLabel(), "Disconnected");
  assertEquals(Object.values(CONNECTION_STATES).map((s) => s.shape), [
    "retry",
    "check",
    "loading",
    "retry",
    "circle",
    "cross",
  ]);
});
