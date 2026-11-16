// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createSidecars } from "@otk/client";

Deno.test("sidecars retain the local server when browser storage's property getter throws", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Blocked", "SecurityError");
    },
  });
  try {
    const sidecars = createSidecars(() => {}, {
      connection: { api: new URL("http://127.0.0.1:1502/api") },
    });
    try {
      assertEquals(sidecars.state.list.map((s) => s.id), ["local"]);
    } finally {
      sidecars.stop();
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
