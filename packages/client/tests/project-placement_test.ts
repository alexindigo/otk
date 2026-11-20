// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { projectPlacement } from "../project-placement.ts";
import { archiveAttention } from "../inbox.ts";

Deno.test("placement keeps unproven lifecycle live and respects manual inactivity", () => {
  for (const availability of ["present", "unknown"] as const) {
    for (const status of ["working", "blocked", "finished", "none"] as const) {
      const row = projectPlacement({
        lifecycle: { availability, archived: false },
        status,
        inactive: true,
        hasSessions: true,
      });
      assertEquals(row, {
        section: status === "none" ? "inactive" : "live",
        annotation: undefined,
      });
    }
  }
  assertEquals(
    projectPlacement({ status: "none", inactive: false, hasSessions: false })
      .section,
    "discovered",
  );
});

Deno.test("archive header rolls up through the shared attention order without consuming unseen", () => {
  assertEquals(archiveAttention([{ status: "finished", unseenCount: null }]), {
    status: "finished",
    count: 1,
    unseenCount: null,
  });
  const rows = [{ status: "finished" as const, unseenCount: 2 }, {
    status: "none" as const,
    unseenCount: 0,
  }, { status: "finished" as const, unseenCount: 6 }];
  assertEquals(archiveAttention(rows), {
    status: "finished",
    count: 3,
    unseenCount: 8,
  });
  assertEquals(
    archiveAttention([...rows, { status: "working", unseenCount: 1 }]),
    { status: "working", count: 4, unseenCount: 9 },
  );
  assertEquals(
    archiveAttention([...rows, { status: "blocked", unseenCount: 1 }]),
    { status: "blocked", count: 4, unseenCount: 9 },
  );
  assertEquals(archiveAttention(rows), {
    status: "finished",
    count: 3,
    unseenCount: 8,
  });
});
