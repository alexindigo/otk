// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { NotificationHub } from "@otk/client";
import { ManualClock } from "../../../tests/support/manual-clock.ts";
import { registerToastChannel } from "../features/notify/toast.ts";
Deno.test("toast consumer keeps keyed active/error replacements past old transient deadlines and expires information at six seconds", () => {
  const clock = new ManualClock();
  using _timers = clock.install();
  const hub = new NotificationHub(
    () => ({ channels: ["toast"] }),
    async () => {},
    (error) => {
      throw error;
    },
  );
  const toast = registerToastChannel(hub);
  try {
    hub.publish({ id: "slot", kind: "info", title: "Old info", actions: [] });
    const old = toast.model.state.items[0];
    hub.publish({
      id: "slot",
      kind: "error",
      title: "Sticky replacement",
      actions: [],
    });
    old.delivery.dismiss();
    hub.publish({
      id: "transient",
      kind: "info",
      title: "Six seconds",
      actions: [],
    });
    hub.publish({
      id: "input",
      kind: "permission",
      title: "Active input",
      actions: [],
    });
    assertEquals(toast.model.state.items.map((item) => item.note.id), [
      "input",
      "transient",
      "slot",
    ]);
    clock.advanceTo(5999);
    assertEquals(
      toast.model.state.items.some((item) => item.note.id === "transient"),
      true,
    );
    clock.advanceTo(6000);
    assertEquals(
      toast.model.state.items.map((item) => [item.note.id, item.note.title]),
      [["input", "Active input"], ["slot", "Sticky replacement"]],
    );
    toast.model.state.items.find((item) => item.note.id === "slot")!.delivery
      .dismiss();
    hub.refresh();
    assertEquals(toast.model.state.items.map((item) => item.note.id), [
      "input",
    ]);
  } finally {
    hub.stop();
    toast.stop();
  }
});
