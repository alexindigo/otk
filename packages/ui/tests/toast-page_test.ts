// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { NotificationHub } from "@otk/client";
import { registerToastChannel } from "../features/notify/toast.ts";

function toastPages() {
  const hub = new NotificationHub(
    () => ({ channels: ["toast"] }),
    async () => {},
    (error) => {
      throw error;
    },
  );
  const { model, stop } = registerToastChannel(hub);
  const publish = (id: string) =>
    hub.publish({ id, kind: "error", title: id, actions: [] });
  for (let i = 1; i <= 7; i++) publish(String(i));
  return {
    model,
    publish,
    visible: () => model.visible().map(({ note }) => note.id),
    remaining: () => model.remaining().map(({ note }) => note.id),
    dismiss: (id: string) =>
      model.state.items.find(({ note }) => note.id === id)!.delivery.dismiss(),
    [Symbol.dispose]() {
      stop();
      hub.stop();
    },
  };
}

Deno.test("toast page survives dismissal and arrival until the list shrinks to one page", () => {
  using toast = toastPages();
  const { model, visible, remaining, dismiss, publish } = toast;
  assertEquals(visible(), ["7", "6", "5"]);
  model.more();
  assertEquals(model.state.page, 1);
  assertEquals(visible(), ["4", "3", "2"]);
  assertEquals(remaining(), ["7", "6", "5", "1"]);

  dismiss("3");
  assertEquals(model.state.page, 1);
  assertEquals(visible(), ["4", "2", "1"]);
  assertEquals(remaining(), ["7", "6", "5"]);

  publish("8");
  assertEquals(model.state.page, 1);
  assertEquals(visible(), ["5", "4", "2"]);

  for (const id of ["8", "7", "6", "5"]) dismiss(id);
  assertEquals(model.state.page, 0);
  assertEquals(visible(), ["4", "2", "1"]);
  assertEquals(remaining(), []);
});

Deno.test("toast page clamps to the last remaining page and wraps on More", () => {
  using toast = toastPages();
  const { model, visible, dismiss } = toast;
  model.more();
  model.more();
  assertEquals(visible(), ["1"]);
  model.more();
  assertEquals(visible(), ["7", "6", "5"]);

  model.more();
  model.more();
  dismiss("1");
  assertEquals(model.state.page, 1);
  assertEquals(visible(), ["4", "3", "2"]);
  model.more();
  assertEquals(visible(), ["7", "6", "5"]);
});
