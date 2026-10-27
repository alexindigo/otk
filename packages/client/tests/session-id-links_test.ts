// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { hashFor, route } from "../session.ts";

Deno.test("session routes admit only canonical qualified session and root identities", () => {
  const selected = {
    sidecarId: "server",
    sessionID: "opcv1-ses_child",
    rootID: "opcv1-ses_root",
  };
  assertEquals(route(hashFor(selected)), selected);
  assertEquals(route("#/server/ses_legacy"), undefined);
  assertEquals(route("#/server/ses_legacy/opcv1-ses_child"), undefined);
  assertEquals(route("#/server/opcv1-ses_root/ses_legacy"), undefined);
  assertEquals(route("#/server/opcv1-ses_%2Fbad"), undefined);
  assertEquals(route("#/server/clcv2-native_1"), {
    sidecarId: "server",
    sessionID: "clcv2-native_1",
  });
});
