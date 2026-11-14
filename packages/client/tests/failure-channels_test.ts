// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DEFAULT_PREFS } from "@otk/protocol";
import { failureNote, notificationPolicy, RequestFailure } from "@otk/client";

Deno.test("linked failure feedback keeps existing channel preferences and on-screen suppression, without input badges", () => {
  const context = {
    focused: false,
    visible: true,
    prefs: { ...DEFAULT_PREFS, "notify.os": true, "notify.sound": true },
    open: { sidecar: "channel-fixture", session: "tstv1-session" },
  };
  const policy = notificationPolicy(() => context);
  const note = failureNote(
    new RequestFailure({
      code: "native.rejected",
      retry: "none",
      diagnosticID: "channel-proof",
      facts: {
        action: "Running session",
        target: { sidecarId: "channel-fixture", sessionID: "tstv1-session" },
        reason: "The session failed",
      },
    }),
  )!;
  assertEquals(policy(note, () => true, true).channels, ["os", "sound"]);
  context.focused = true;
  assertEquals(policy(note, () => true, true).channels, []);
});
