// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import {
  createPreferences,
  DEFAULT_PREFS,
  isPreference,
  PreferenceRegistry,
  registerModelPreferences,
} from "../mod.ts";

Deno.test("model preference contributions provide independent defaults and accept only bounded unique ModelRef arrays", () => {
  const registry = new PreferenceRegistry();
  registerModelPreferences(registry);
  assertEquals(registry.list().map((item) => item.key), [
    "models.recent",
    "models.favourite",
  ]);
  assertEquals(DEFAULT_PREFS["models.recent"], []);
  assertEquals(DEFAULT_PREFS["models.favourite"], []);
  const first = registry.defaults();
  first["models.recent"].push({ provider: "one", model: "nested/model" });
  assertEquals(registry.defaults()["models.recent"], []);
  assertEquals(first["models.favourite"], []);
  const composed = createPreferences();
  for (
    const [key, cap] of [["models.recent", 10], [
      "models.favourite",
      50,
    ]] as const
  ) {
    const full = Array.from(
      { length: cap },
      (_, i) => ({ provider: "one", model: `model-${i}` }),
    );
    assert(composed.validate(key, full));
    assert(
      isPreference(key, [{ provider: "one", model: "shared" }, {
        provider: "two",
        model: "shared",
      }]),
    );
    // Pair identity is structural, so separators inside either identifier cannot collide.
    assert(
      isPreference(key, [{ provider: "a/b", model: "c" }, {
        provider: "a",
        model: "b/c",
      }]),
    );
    for (
      const invalid of [
        null,
        {},
        "[]",
        true,
        [null],
        [[]],
        ["one/model"],
        [{ provider: "one" }],
        [{ model: "model" }],
        [{ provider: "", model: "model" }],
        [{ provider: "one", model: "" }],
        [{ provider: 1, model: "model" }],
        [{ provider: "one", model: 1 }],
        [{ providerID: "one", modelID: "model" }],
        [{ provider: "one", model: "model", variant: "high" }],
        [Object.create({ provider: "one", model: "model" })],
        [{ provider: "one", model: "same" }, {
          model: "same",
          provider: "one",
        }],
        [...full, { provider: "one", model: "extra" }],
      ]
    ) {
      assertEquals(
        isPreference(key, invalid),
        false,
        `${key}: ${JSON.stringify(invalid)}`,
      );
    }
  }
});
