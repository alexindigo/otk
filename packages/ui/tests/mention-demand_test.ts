// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { type PromptContext, PromptRegistry } from "../registries/prompt.ts";
import { registerMentionsPrompt } from "../features/prompt/mentions.ts";

for (const resources of [false, true]) {
  Deno.test(`mention demand requests files only on input and never blocks them on resource warm-up (resources=${resources})`, async () => {
    const calls: string[] = [], pending = Promise.withResolvers<void>();
    const registry = new PromptRegistry();
    registerMentionsPrompt(registry);
    const [feature] = registry.create({
      supports: () => resources,
      fail: (cause: unknown) => {
        throw cause;
      },
      directoryCatalog: {
        state: {
          catalog: {
            directory: "/p",
            generation: "g",
            revision: 1,
            paths: { style: "posix", separator: "/" },
            values: {
              files: {
                state: "ready",
                revision: 1,
                value: [{
                  path: "one.txt",
                  canonicalPath: "/p/one.txt",
                  directory: false,
                }],
              },
            },
          },
        },
        ready(kind: string) {
          calls.push(kind);
          return kind === "resources" ? pending.promise : Promise.resolve();
        },
      },
    } as unknown as PromptContext);
    assertEquals(calls, []);
    let labels: string[] | undefined;
    const work = feature.source!.options({ start: 0, end: 4, query: "one" })
      .then((options) => {
        labels = options.map((option) => option.label);
      });
    try {
      for (let n = 0; n < 10; n++) await Promise.resolve();
      assertEquals(labels, ["one.txt"]);
      assertEquals(
        calls,
        resources ? ["files", "agents", "resources"] : ["files", "agents"],
      );
    } finally {
      pending.resolve();
      await work;
    }
  });
}
