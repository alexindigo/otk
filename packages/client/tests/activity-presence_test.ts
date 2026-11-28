// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { ActivityPresence } from "../activity-presence.ts";

const view = (presence: ActivityPresence) => ({
  mounted: presence.mounted,
  retiring: presence.retiring,
});
const hidden = { mounted: false, retiring: false };
const visible = { mounted: true, retiring: false };
const retiring = { mounted: true, retiring: true };

Deno.test("a closed activity pill disappears when its roster empties", () => {
  const presence = new ActivityPresence();
  assertEquals(view(presence), hidden);
  presence.publish(2);
  assertEquals(view(presence), visible);
  presence.publish(0);
  assertEquals(view(presence), hidden);
});

Deno.test("an open activity pill retires until its popover closes", () => {
  const presence = new ActivityPresence();
  presence.publish(1);
  presence.opened();
  presence.publish(0);
  assertEquals(view(presence), retiring);
  presence.closed();
  assertEquals(view(presence), hidden);
  presence.publish(1);
  assertEquals(view(presence), visible);
  presence.publish(0);
  assertEquals(view(presence), hidden);
});

Deno.test("a new roster cancels retirement without closing the popover", () => {
  const presence = new ActivityPresence();
  presence.publish(1);
  presence.opened();
  presence.publish(0);
  assertEquals(view(presence), retiring);
  presence.publish(1);
  assertEquals(view(presence), visible);
  presence.publish(0);
  assertEquals(view(presence), retiring);
});
