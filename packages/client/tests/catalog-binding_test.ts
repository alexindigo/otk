// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertStrictEquals } from "@std/assert";
import {
  createCatalogBinding,
  createCatalogResource,
} from "../catalog-resource.ts";

Deno.test("borrowed catalog readiness follows replacement of a still-loading owner without copying values", async () => {
  const old = Promise.withResolvers<{ folder: string }>();
  const next = Promise.withResolvers<{ folder: string }>();
  const started = Promise.withResolvers<void>();
  const a = createCatalogResource({
    connection: () => ({ key: "old", connected: true, available: true }),
    load: () => {
      started.resolve();
      return old.promise;
    },
  });
  const b = createCatalogResource({
    connection: () => ({ key: "new", connected: true, available: true }),
    load: () => next.promise,
  });
  const binding = createCatalogBinding<{ folder: string }>();
  try {
    binding.bind(a);
    binding.connect();
    await started.promise;
    assertEquals(a.state.loading, true);
    const ready = binding.ready();
    binding.bind(b);
    binding.connect();
    const value = { folder: "new" };
    next.resolve(value);
    await ready;
    assertEquals(binding.state.loading, false);
    assertStrictEquals(binding.state.value, value);
    old.resolve({ folder: "retired" });
    for (let n = 0; n < 10; n++) await Promise.resolve();
    assertStrictEquals(binding.state.value, value);
  } finally {
    old.resolve({ folder: "retired" });
    next.resolve({ folder: "new" });
    binding.dispose();
    a.dispose();
    b.dispose();
  }
});

Deno.test("retired borrowed catalogs settle waiters and cannot acquire a replacement session's values", async () => {
  const pending = Promise.withResolvers<string>();
  const source = createCatalogResource({
    connection: () => ({ key: "old", connected: true, available: true }),
    load: () => pending.promise,
  });
  const replacement = createCatalogResource({
    connection: () => ({ key: "new", connected: true, available: true }),
    load: () => Promise.resolve("new session"),
  });
  const binding = createCatalogBinding<string>();
  try {
    binding.bind(source);
    binding.connect();
    const ready = binding.ready();
    binding.dispose();
    binding.bind(replacement);
    await ready;
    assertEquals(binding.state, {
      available: false,
      loading: false,
      error: "",
    });
  } finally {
    pending.resolve("old");
    binding.dispose();
    source.dispose();
    replacement.dispose();
  }
});
