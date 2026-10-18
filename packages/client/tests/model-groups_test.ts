// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { modelGroups, modelKey } from "../mod.ts";
import type { ModelCatalog } from "@otk/protocol";

Deno.test("model groups deduplicate favourites and recent, order providers newest first and retain only relevant deprecated models", () => {
  const model = (
    id: string,
    releaseDate: string,
    status: "active" | "deprecated" = "active",
  ) => ({
    id,
    name: id,
    releaseDate,
    status,
    variants: [],
    free: id === "new",
  });
  const catalog: ModelCatalog = {
    providers: [
      {
        id: "one",
        name: "One",
        models: [
          model("old", "2020-01-01"),
          model("hidden", "2021-01-01", "deprecated"),
          model("new", "2026-01-01"),
          model("favourite", "2019-01-01", "deprecated"),
          model("recent", "2019-01-01", "deprecated"),
          model("current", "2018-01-01", "deprecated"),
        ],
      },
      { id: "two", name: "Two", models: [model("new", "2026-01-01")] },
    ],
  };
  const ref = (model: string) => ({ provider: "one", model });
  const input = structuredClone(catalog);
  const result = modelGroups(catalog, [ref("favourite"), ref("gone")], [
    ref("favourite"),
    ref("recent"),
  ], ref("current"));
  assertEquals(
    result.map((group) => [
      group.label,
      group.items.map((item) => item.ref.model),
    ]),
    [["Favourites", ["favourite"]], ["Recent", ["recent"]], ["One", [
      "new",
      "old",
      "current",
    ]], ["Two", ["new"]]],
  );
  assertEquals(result[2].items[0].free, true);
  assertEquals(result[0].items[0].favourite, true);
  assertEquals(result[0].items[0].subtitle, "One");
  assertEquals(result[1].items[0].favourite, false);
  assertEquals(result[1].items[0].subtitle, "One");
  assertEquals(result[2].items[0].subtitle, undefined);
  assertEquals(result[2].items[0].key, modelKey(result[2].items[0].ref));
  assertEquals(modelGroups(undefined, [], []), []);
  assertEquals(catalog, input);
  assertEquals(
    modelKey({ provider: "a/b", model: "c" }) ===
      modelKey({ provider: "a", model: "b/c" }),
    false,
  );
});
