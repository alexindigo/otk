// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import {
  scrollbarGeometry,
  scrollbarPosition,
} from "../components/scrollbar.ts";

Deno.test("scrollbar geometry and drag share the same proportional range", () => {
  assertEquals(scrollbarGeometry(200, 1000, 400, 200), {
    size: 40,
    offset: 80,
    travel: 160,
    maximum: 800,
  });
  assertEquals(scrollbarPosition(120, 200, 1000, 200), 600);
  assertEquals(scrollbarGeometry(200, 100, 0, 200), {
    size: 200,
    offset: 0,
    travel: 0,
    maximum: 0,
  });
  assertEquals(scrollbarPosition(-20, 200, 1000, 200), 0);
  assertEquals(scrollbarPosition(400, 200, 1000, 200), 800);
});
