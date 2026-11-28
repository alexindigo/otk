// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  connectionFeedback,
  connectionState,
} from "../components/connection-light.ts";

Deno.test("version skew is an expected updated state, never Connecting failed", () => {
  const connection = {
    label: "This server",
    status: "protocol mismatch" as const,
    harness: "connected" as const,
    error: "Reload after updating the client and sidecar together.",
  };
  assertEquals(connectionState(connection), "updated");
  assertEquals(connectionFeedback(connection)?.text, "OTK was updated");
});
