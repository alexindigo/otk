// SPDX-License-Identifier: LGPL-3.0-only
import { expect } from "@playwright/test";
import { test as stateTest } from "./test-state.ts";

/** Browser evidence never acquires a native stack; failing capture still unwinds fixtures. */
export const test = stateTest.extend<{ browserEvidence: void }>({
  browserEvidence: [async ({ context }, use, info) => {
    const errors: string[] = [];
    const console: string[] = [];
    context.on("weberror", (event) => errors.push(String(event.error())));
    context.on("console", (message) => {
      console.push(`${message.type()}: ${message.text()}`);
      if (console.length > 200) console.shift();
    });
    try {
      await use();
    } finally {
      await info.attach("browser-observations", {
        body: JSON.stringify(
          {
            errors,
            browserVersion: context.browser()?.version(),
            console,
            pages: context.pages().map((p) => p.url()),
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      expect(errors, "Uncaught browser exceptions").toEqual([]);
    }
  }, { auto: true }],
});
export { expect };
