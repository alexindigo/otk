// SPDX-License-Identifier: LGPL-3.0-only
import { assertFalse, assertMatch } from "@std/assert";

Deno.test("D65: project rank flows from the server replica, not UI interaction or record positions", async () => {
  const read = (path: string) =>
    Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
  const resources = await read("packages/client/server-resources.ts");
  const projects = resources.slice(
    resources.indexOf("    projects: (now) =>"),
    resources.indexOf("    tabSnapshot(p)"),
  );
  assertMatch(projects, /projectHierarchy\(orderProjectRows\(rows\)\)/);
  assertFalse(/stable-order|holdProjectOrder/.test(resources));
  assertFalse(/\.sort\(|\.order\b/.test(projects));
  assertFalse(
    /orderInteraction|holdOrder/.test(
      await read("packages/ui/components/ProjectInbox.tsx"),
    ),
  );
  const sql = await read("packages/store/features/projects.ts");
  assertFalse(/\b(position|rank)\b/.test(sql));
});
