// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import type { ActivityGroup } from "@otk/client";
import { createRoot, createSignal, flush } from "solid-js";
import { activityRecord } from "../components/activity-record.ts";

function verify() {
  createRoot((dispose) => {
    try {
      const [entry, setEntry] = createSignal<ActivityGroup>({
        key: "records:first",
        title: "",
        members: ["first"],
        revision: 1,
      });
      let mounts = 0;
      const view: unknown = activityRecord(
        entry,
        (id) => `${id}:${++mounts}`,
        () => "group",
      );
      if (typeof view !== "function") throw new Error("Expected reactive view");
      const first = view();
      assertEquals(first, "first:1");
      setEntry({ ...entry(), members: ["first"], revision: 2 });
      flush();
      assertStrictEquals(
        view(),
        first,
        "record update replaced the focused leaf",
      );
      setEntry({ ...entry(), count: 2, members: ["first", "second"] });
      flush();
      assertEquals(view(), "group");
      setEntry({ ...entry(), count: undefined, members: ["second"] });
      flush();
      assertEquals(view(), "second:2");
    } finally {
      dispose();
    }
  });
}

if (import.meta.main) {
  verify();
} else {
  Deno.test("activity record revisions retain the mounted leaf until its identity changes", async () => {
    // Exercise Solid's client reactivity; its default Deno export is for SSR.
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env=COMPANION_CENSUS",
        "--conditions=browser",
        import.meta.filename!,
      ],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    assertEquals(result.code, 0);
  });
}
