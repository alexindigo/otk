// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { NotificationHub } from "@otk/client";
import { serverNotifications } from "../shell/notifications.ts";
import { ManualClock } from "../../../tests/support/manual-clock.ts";
import { registerToastChannel } from "../features/notify/toast.ts";

Deno.test("persistent server delivery dedupes retries and honors dismissal until the state changes", () => {
  const clock = new ManualClock();
  using _timers = clock.install();
  const hub = new NotificationHub(
    () => ({ channels: ["toast"] }),
    async () => {},
    (error) => {
      throw error;
    },
  );
  const servers = serverNotifications(hub);
  const { model, stop } = registerToastChannel(hub);
  try {
    const sidecar = { id: "local", label: "This server" };
    const outage = { kind: "unreachable", since: 10 } as const;
    const offline = { ...sidecar, continuity: outage };
    servers.update([offline]);
    const first = model.state.items[0];
    servers.update([{ ...offline, continuity: { ...outage } }]);
    assertEquals(model.state.items[0].delivery === first.delivery, true);
    assertEquals(clock.pending, 0);
    clock.advanceTo(7000);
    assertEquals(model.state.items.length, 1);
    first.delivery.dismiss();
    servers.update([{
      ...offline,
      continuity: { ...outage, refused: "Probe failed" },
    }]);
    assertEquals(model.state.items.length, 0);
    servers.update([{
      ...sidecar,
      continuity: { kind: "updated", build: "b" },
    }]);
    assertEquals(model.state.items.map(({ note }) => note.title), [
      "OTK was updated",
    ]);
    servers.update([]);
    assertEquals(model.state.items.length, 0);
  } finally {
    stop();
    hub.stop();
  }
});

Deno.test("toast hold preserves a transient and restarts a full six seconds", () => {
  const clock = new ManualClock();
  using _timers = clock.install();
  const advance = (ms: number) => clock.advanceTo(clock.now() + ms);
  const hub = new NotificationHub(
    () => ({ channels: ["toast"] }),
    async () => {},
    (error) => {
      throw error;
    },
  );
  const toast = registerToastChannel(hub);
  const { model } = toast;
  try {
    hub.publish({ id: "done", kind: "done", title: "Done", actions: [] });
    advance(3000);
    model.hold("done", true);
    advance(7000);
    assertEquals(model.state.items.map(({ note }) => note.id), ["done"]);
    model.hold("done", false);
    advance(5999);
    assertEquals(model.state.items.length, 1);
    advance(1);
    assertEquals(model.state.items.length, 0);
    model.hold("done", false);
    hub.publish({
      id: "permission",
      kind: "permission",
      title: "Permission",
      actions: [],
    });
    model.hold("permission", true);
    model.hold("permission", false);
    assertEquals(clock.pending, 0);
    advance(7000);
    assertEquals(model.state.items.map(({ note }) => note.id), ["permission"]);
  } finally {
    toast.stop();
    hub.stop();
  }
});
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
