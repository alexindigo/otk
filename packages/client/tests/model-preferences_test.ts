// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { isPreference, type ModelRef } from "@otk/protocol";
import { recordRecentModel, toggleFavouriteModel } from "../mod.ts";

const model = (id: number): ModelRef => ({
  provider: "provider",
  model: `model-${id}`,
});

Deno.test("successful-send recent helper deduplicates provider/model pairs in most-recent-first order and caps at ten", () => {
  const recent = Array.from({ length: 10 }, (_, i) => model(i));
  const before = structuredClone(recent);
  assertEquals(recordRecentModel(recent, model(5)), [
    model(5),
    ...recent.filter((_, i) => i !== 5),
  ]);
  assertEquals(recordRecentModel(recent, model(10)), [
    model(10),
    ...recent.slice(0, 9),
  ]);
  const otherProvider = { provider: "other", model: "model-0" };
  assertEquals(recordRecentModel([model(0)], otherProvider), [
    otherProvider,
    model(0),
  ]);
  assertEquals(recordRecentModel(recent, undefined), recent);
  assertEquals(recordRecentModel([], model(0)), [model(0)]);
  assertEquals(recent, before);
  assertEquals(
    isPreference("models.recent", recordRecentModel(recent, model(10))),
    true,
  );
});

Deno.test("favourite helper toggles exact model pairs, preserves ordering and existing favourites at the fifty cap", () => {
  const favourites = Array.from({ length: 49 }, (_, i) => model(i));
  const before = structuredClone(favourites);
  const full = toggleFavouriteModel(favourites, model(49));
  assertEquals(full, [model(49), ...favourites]);
  assertEquals(toggleFavouriteModel(full, model(50)), full);
  assertEquals(
    toggleFavouriteModel(full, model(20)),
    full.filter((item) => item.model !== "model-20"),
  );
  assertEquals(
    toggleFavouriteModel(favourites, { provider: "other", model: "model-0" })
      .length,
    50,
  );
  assertEquals(toggleFavouriteModel([], model(0)), [model(0)]);
  assertEquals(toggleFavouriteModel([model(0)], model(0)), []);
  assertEquals(favourites, before);
  assertEquals(isPreference("models.favourite", full), true);
});
