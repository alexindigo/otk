// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { projectPlacement } from "../project-placement.ts";

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

Deno.test("a checkout with an unknown repository is never placed as a live project", () => {
  for (const status of ["working", "blocked", "none"] as const) {
    assertEquals(
      projectPlacement({
        lifecycle: {
          availability: "unknown",
          archived: false,
          topology: {
            repoID: "lost",
            canonicalRoot: "otk:unknown-repository",
            leafDirectory: "/lost",
          },
        },
        status,
        inactive: false,
        hasSessions: true,
      }).section,
      "archived",
    );
  }
});

Deno.test("D78: a yellow checkout with live work does not move into Archived", () => {
  const placement = {
    lifecycle: { archived: true },
    status: "finished" as const,
    inactive: true,
    hasSessions: true,
  };
  assertEquals(projectPlacement(placement).section, "archived");
  assertEquals(
    projectPlacement({ ...placement, liveWork: true }).section,
    "live",
  );
});
