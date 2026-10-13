// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { OtkDb } from "../../sidecar/db/db.ts";
import { Frecency } from "../../sidecar/db/frecency.ts";
import { frecency } from "@otk/protocol";
import {
  mention,
  mentionQuery,
  rank,
} from "../../web/src/ui/prompt/autocomplete.ts";
import { fixture } from "../support/config.ts";
Deno.test("frecency stores canonical project paths, increments and survives reopen with TUI daily decay", async () => {
  const root = await fixture(), db = new OtkDb(root), store = new Frecency(db);
  store.bump("/project", "README.md");
  store.bump("/project", "./README.md");
  assertEquals(store.list("/project")[0].score, 2);
  assertEquals(store.list("/project")[0].path, "/project/README.md");
  db.close();
  const next = new OtkDb(root);
  assertEquals(new Frecency(next).list("/project")[0].score, 2);
  assertEquals(new Frecency(next).list("/other"), []);
  next.close();
  assertEquals(frecency({ path: "x", score: 4, last: 0 }, 86_400_000), 2);
  assertEquals(
    rank(
      [{ id: "a", label: "AAA.md", path: "AAA.md" }, {
        id: "r",
        label: "README.md",
        path: "README.md",
      }],
      "",
      [{ path: "/project/README.md", score: 2, last: Date.now() }],
      "/project",
    )[0].label,
    "README.md",
  );
  assertEquals(mention("hello @READ", 11), {
    start: 6,
    end: 11,
    query: "READ",
  });
  assertEquals(mention("email@example.com", 17), undefined);
  assertEquals(mentionQuery("README.md#10-20"), {
    query: "README.md",
    range: { start: 10, end: 20 },
  });
});
