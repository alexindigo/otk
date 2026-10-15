// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { NotificationHub } from "@otk/client";
import { registerToastChannel } from "../features/notify/toast.ts";
Deno.test("toast consumer keeps keyed active/error replacements past old transient deadlines and expires information at six seconds", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 6100));
    assertEquals(
      toast.model.state.items.map((item) => [item.note.id, item.note.title]),
      [["slot", "Sticky replacement"], ["input", "Active input"]],
    );
    toast.model.state.items[0].delivery.dismiss();
    hub.refresh();
    assertEquals(toast.model.state.items.map((item) => item.note.id), [
      "input",
    ]);
  } finally {
    hub.stop();
    toast.stop();
  }
});
