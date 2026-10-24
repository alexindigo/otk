// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  CONNECTION_STATES,
  type ConnectionInput,
  connectionLabel,
  connectionState,
} from "../components/connection-light.ts";

const healthy: ConnectionInput = {
  label: "This server",
  status: "connected",
  harness: "connected",
};
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
      "protocol mismatch",
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
    "✓",
    "◌",
    "↻",
    "○",
    "×",
  ]);
});
