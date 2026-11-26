// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createProjectOrder, orderProjectRows } from "../project-order.ts";

Deno.test("project-order replica applies rank and ordinal atomically and waits for the server revision", async () => {
  const order = createProjectOrder();
  assertEquals(order.ready, false);
  const projects = [
    { id: "first", directories: ["/z-root", "/z-child", "/a-child"] },
    { id: "second", directories: ["/b"] },
  ];
  order.receive({ t: "projects.order", revision: 2, projects });
  assertEquals(order.ready, true);
  const rows = () =>
    orderProjectRows(
      ["/b", "/a-child", "/z-root", "/z-child", "/missing"].map((
        directory,
      ) => ({
        row: { directory },
        serverOrder: 0,
        slot: order.slot(directory),
      })),
    ).map(({ directory }) => directory);
  assertEquals(rows(), ["/z-root", "/z-child", "/a-child", "/b", "/missing"]);
  let settled = false;
  const pending = order.settled(4).then(() => settled = true);
  order.receive({ t: "projects.order", revision: 1, projects: [] });
  await Promise.resolve();
  assertEquals(settled, false);
  assertEquals(order.slot("/z-child"), { id: "first", rank: 0, ordinal: 1 });
  order.receive({
    t: "projects.order",
    revision: 5,
    projects: [...projects].reverse(),
  });
  await pending;
  assertEquals(rows(), ["/b", "/z-root", "/z-child", "/a-child", "/missing"]);
  order.stop();
  assertEquals(order.ready, false);
  assertEquals(order.slot("/z-root"), undefined);
});
