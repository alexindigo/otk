// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DirectoryCatalogs } from "@otk/harness-opencode-v1";
import type { ProviderReadPort } from "@otk/harness";

declare module "@otk/protocol" {
  interface DirectoryCatalogKinds {
    externalInventory: { id: string; label: string }[];
  }
}

Deno.test("a standalone feature contributes a directory inventory without changing catalog machinery", async () => {
  let acquired = 0;
  const catalog = new DirectoryCatalogs({
    read() {
      throw new Error("No native read selected");
    },
    release() {},
  } as unknown as ProviderReadPort, {
    pending: 4,
    contributions: {
      externalInventory: (directory) => {
        acquired++;
        return Promise.resolve([{ id: directory, label: "External feature" }]);
      },
    },
  });
  const first = catalog.acquire("/independent");
  const second = catalog.acquire("/independent");
  try {
    assertEquals(await first.get("externalInventory"), [{
      id: "/independent",
      label: "External feature",
    }]);
    assertEquals(
      await second.get("externalInventory"),
      await first.get("externalInventory"),
    );
    assertEquals(acquired, 1);
    first.release();
    assertEquals(
      (await second.get("externalInventory"))[0].label,
      "External feature",
    );
  } finally {
    first.release();
    second.release();
    await catalog.stop();
  }
  assertEquals(catalog.size, 0);
});
