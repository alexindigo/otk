// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { readText } from "../clipboard.ts";

Deno.test("clipboard shortcut reads preserve native paste on plain HTTP and refusal", async () => {
  const secure = Object.getOwnPropertyDescriptor(globalThis, "isSecureContext");
  const navigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let calls = 0;
  try {
    Object.defineProperty(globalThis, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        get clipboard() {
          calls++;
          return { readText: () => Promise.resolve("selected source") };
        },
      },
    });
    assertEquals(await readText(), undefined);
    assertEquals(calls, 0);
    Object.defineProperty(globalThis, "isSecureContext", { value: true });
    assertEquals(await readText(), "selected source");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { readText: () => Promise.reject(Error("denied")) } },
    });
    assertEquals(await readText(), undefined);
    Object.defineProperty(globalThis, "navigator", { value: {} });
    assertEquals(await readText(), undefined);
  } finally {
    for (
      const [key, descriptor] of [["isSecureContext", secure], [
        "navigator",
        navigator,
      ]] as const
    ) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
