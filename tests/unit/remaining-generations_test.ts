// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertThrows } from "@std/assert";
import {
  assertCatalogGenerations,
  type CatalogWatchObservation,
} from "../support/remaining-generations.ts";

const wire = (socket: string, sent: boolean, frame: object) => ({
  method: `Network.webSocketFrame${sent ? "Sent" : "Received"}`,
  params: {
    requestId: socket,
    response: { opcode: 1, payloadData: JSON.stringify(frame) },
  },
});
const generation = (
  socket: string,
) => [
  wire(socket, true, { t: "hello" }),
  wire(socket, false, { t: "welcome" }),
  ...["catalogs.watch", "frecency.list"].map((method) =>
    wire(socket, true, { t: "request", method, params: { directory: "/p" } })
  ),
];
const watches = (): CatalogWatchObservation[] =>
  [true, false].map((closed, n) => ({
    id: n + 1,
    directory: "/p",
    acquired: 1,
    subscriptions: 1,
    releases: closed ? 1 : 0,
    unsubscriptions: closed ? 1 : 0,
    aborted: closed,
    latePublications: 0,
  }));

Deno.test("connection generations admit exactly two acquisitions each and join prior native watch cleanup", () => {
  const events = [...generation("old"), ...generation("new")];
  assertEquals(assertCatalogGenerations(events, watches(), "/p").length, 2);
  const closed = watches();
  Object.assign(closed[1], { releases: 1, unsubscriptions: 1, aborted: true });
  assertEquals(assertCatalogGenerations(events, closed, "/p", true).length, 2);
});
Deno.test("generation proof rejects duplicated demand, refresh, missing load and leaked old leases", () => {
  const events = [...generation("old"), ...generation("new")];
  for (
    const method of [
      "catalogs.watch",
      "frecency.list",
      "catalogs.refresh",
      "find.files",
    ]
  ) {
    assertThrows(() =>
      assertCatalogGenerations(
        [
          ...events,
          wire("new", true, {
            t: "request",
            method,
            params: { directory: "/p" },
          }),
        ],
        watches(),
        "/p",
      )
    );
  }
  assertThrows(() =>
    assertCatalogGenerations(events.slice(0, -1), watches(), "/p")
  );
  for (const key of ["releases", "unsubscriptions"]) {
    const leaked = watches();
    Object.assign(leaked[0], { [key]: 0 });
    assertThrows(() => assertCatalogGenerations(events, leaked, "/p"));
  }
  const late = watches();
  late[0].latePublications = 1;
  assertThrows(() => assertCatalogGenerations(events, late, "/p"));
});
