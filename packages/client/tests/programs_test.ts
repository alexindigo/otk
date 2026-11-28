// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { createPrograms } from "../programs.ts";

Deno.test("programs replicate one complete membership revision per connection", async () => {
  const programs = createPrograms();
  assertEquals(programs.ready, false);
  const first = {
    t: "programs" as const,
    revision: 7,
    auto: true,
    programs: [],
    members: { p: { program: null, by: "user" as const } },
  };
  programs.receive(first);
  assertEquals(programs.ready, true);
  assertEquals(programs.auto, true);
  assertEquals(programs.member("p"), { id: null, by: "user" });
  programs.receive({ ...first, revision: 6, auto: false, members: {} });
  assertEquals(programs.auto, true);
  const settled = programs.settled(8);
  programs.receive({ ...first, revision: 8, auto: false, members: {} });
  await settled;
  assertEquals(programs.auto, false);
  assertEquals(programs.member("p"), undefined);
  const detached = assertRejects(() => programs.settled(9));
  programs.stop();
  await detached;
  assertEquals(programs.ready, false);
  programs.receive({ ...first, revision: 1 });
  assertEquals(programs.member("p"), { id: null, by: "user" });
});
