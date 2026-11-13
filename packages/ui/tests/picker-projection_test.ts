// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { pickerProjection } from "../components/picker-projection.ts";

Deno.test("picker search revision indexes groups, available navigation and exact values", () => {
  const first = { key: "a", label: "Alpha", value: { id: 1 } };
  const locked = { key: "b", label: "Beta", unavailable: "No target" };
  const last = {
    key: "",
    label: "Gamma",
    description: "Third",
    search: "Extra",
  };
  const groups: {
    key: string;
    label: string;
    items: (typeof first | typeof locked | typeof last)[];
  }[] = [{ key: "one", label: "One", items: [first, locked] }, {
    key: "two",
    label: "Two",
    items: [last],
  }];
  const all = pickerProjection(groups, "");
  assertEquals(all.keys, [
    "heading:one",
    "option:a",
    "option:b",
    "heading:two",
    "option:",
  ]);
  assertEquals(all.available, ["a", ""]);
  assertEquals(all.indices.get(""), 1);
  assertEquals(all.items.get("a"), first);
  assertEquals(all.rows.get("option:b"), {
    kind: "option",
    label: "One",
    item: locked,
    position: 2,
    size: 2,
  });
  const search = pickerProjection(groups, "  eXTra ");
  assertEquals(search.available, [""]);
  assertEquals(search.rows.get("heading:two")?.first, true);
  assertEquals(search.rows.get("option:")?.size, 1);
  assertEquals(pickerProjection(groups, "third").available, [""]);
  assertEquals(pickerProjection(groups, "missing").keys, []);
  assertEquals(all.available, ["a", ""]);
});

Deno.test("picker key lookup and navigation never reread the catalog revision", () => {
  let reads = 0;
  const items = Array.from({ length: 1610 }, (_, i) => ({
    key: String(i),
    get label() {
      reads++;
      return `Model ${i}`;
    },
  }));
  const snapshot = pickerProjection([{ key: "models", items }], "model");
  assertEquals(reads, 1610);
  for (const key of snapshot.available) {
    assertEquals(snapshot.items.get(key), items[Number(key)]);
    assertEquals(snapshot.indices.get(key), Number(key));
  }
  assertEquals(reads, 1610);
});
