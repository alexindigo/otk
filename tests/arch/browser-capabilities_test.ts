// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { dependencySpecifiers, productionSources, Source } from "./analysis.ts";

/** Conservative Vite graph: public package barrels, static/dynamic imports and
 * module-worker URLs. All browser libraries are roots, including content even
 * when today's application tree-shakes it out. New imported packages follow. */
export function browserGraph(files: ReadonlyMap<string, string>): Set<string> {
  const queue = [...files.keys()].filter((path) =>
    /^(?:web\/src\/|packages\/(?:client|ui|protocol|content)\/)/.test(path)
  );
  const result = new Set<string>();
  for (const path of queue) {
    if (result.has(path) || !/\.[cm]?[jt]sx?$/.test(path)) continue;
    result.add(path);
    const source = new Source(files.get(path)!, path);
    const specifiers = dependencySpecifiers(source.text, { runtime: true });
    for (const node of source.all) {
      if (node.type === "NewExpression" && source.name(node.callee) === "URL") {
        const specifier = source.string(node.arguments[0]);
        if (specifier) specifiers.push(specifier);
      }
    }
    for (const specifier of specifiers) {
      if (!specifier) continue;
      const target = specifier.startsWith("@otk/")
        ? `packages/${specifier.slice(5)}/mod.ts`
        : specifier.startsWith(".")
        ? new URL(specifier, `file:///source/${path}`).pathname.slice(8)
        : undefined;
      if (target && files.has(target)) queue.push(target);
    }
  }
  return result;
}

export function capabilityErrors(path: string, text: string): string[] {
  const source = new Source(text, path);
  const errors = new Set<string>();
  for (const node of source.all) {
    const name = source.name(node)?.replace(
      /^(?:(?:globalThis|window|self)\.)+/,
      "",
    );
    if (name === "crypto.randomUUID") errors.add("use protocol randomID");
    if (
      name?.startsWith("crypto.subtle") && path !== "packages/protocol/hash.ts"
    ) {
      errors.add("use protocol sha256");
    }
    if (
      name?.startsWith("navigator.clipboard") &&
      path !== "packages/ui/clipboard.ts"
    ) {
      errors.add("use the UI clipboard owner");
    }
    if (
      node.type === "CallExpression" || node.type === "OptionalCallExpression"
    ) {
      const authority = source.name(node.callee);
      if (
        /^(?:(?:globalThis|window|self)\.|document\.defaultView\.)+(?:confirm|alert|prompt)(?:\.(?:call|apply|bind))?$/
          .test(authority ?? "") ||
        (node.callee.type === "Identifier" &&
          /^(?:confirm|alert|prompt)$/.test(authority ?? "") &&
          !source.binding(authority!, node.callee))
      ) errors.add("use OTK Dialog, not a browser-native modal");
    }
  }
  return [...errors];
}

Deno.test("browser capabilities cannot bypass their plain HTTP owners", async () => {
  const files = await productionSources();
  const graph = browserGraph(files);
  assert(graph.has("packages/ui/highlight/worker.ts"));
  assert(graph.has("packages/client/sidecars.ts"));
  assert(graph.has("packages/protocol/requests.ts"));
  assert(!graph.has("core/auth/local.ts"));
  const errors = [...graph].flatMap((path) =>
    capabilityErrors(path, files.get(path)!).map((error) => `${path}: ${error}`)
  );
  assertEquals(errors, []);
});

Deno.test("D54 bans browser-native modal functions without banning product commands", () => {
  for (
    const code of [
      "confirm('Proceed?')",
      "window.alert('Notice')",
      "globalThis['prompt']?.('Name')",
      "const { confirm: ask } = self; ask('Proceed?')",
      "const page = window; page.alert.call(page, 'Notice')",
      "document.defaultView?.confirm('Proceed?')",
    ]
  ) assert(capabilityErrors("web/src/dialogs.ts", code).length > 0, code);
  for (
    const code of [
      "function confirm() {} confirm()",
      "function act(prompt) { prompt() }",
      "client.prompt(parts)",
      "owner.confirm()",
    ]
  ) assertEquals(capabilityErrors("web/src/dialogs.ts", code), [], code);
});

Deno.test("capability gate follows aliases, computed access, barrels and workers", () => {
  for (
    const code of [
      "crypto.randomUUID()",
      "window.crypto['randomUUID']()",
      "globalThis.window.crypto.randomUUID()",
      "globalThis.window.navigator.clipboard.writeText('x')",
      "const c = globalThis.crypto; c.randomUUID()",
      "const { randomUUID: id } = crypto; id()",
      "crypto?.subtle?.digest('SHA-256', bytes)",
      "const c = navigator['clipboard']; c.writeText('x')",
    ]
  ) assert(capabilityErrors("web/src/bypass.ts", code).length > 0, code);
  const graph = browserGraph(
    new Map([
      [
        "web/src/main.ts",
        "export * from '@otk/extra'; new Worker(new URL('../../packages/extra/worker.ts', import.meta.url));",
      ],
      ["packages/extra/mod.ts", "export * from './nested.ts'"],
      ["packages/extra/nested.ts", "crypto.randomUUID()"],
      ["packages/extra/worker.ts", "crypto.subtle.digest('SHA-256', bytes)"],
    ]),
  );
  assert(graph.has("packages/extra/nested.ts"));
  assert(graph.has("packages/extra/worker.ts"));
});

Deno.test("browser graph excludes erased types but keeps runtime and mixed imports", () => {
  const graph = browserGraph(
    new Map([
      [
        "web/src/main.ts",
        `
      import type { A } from '../../core/types.ts';
      export type { B } from '../../core/types.ts';
      export type * from '../../core/types.ts';
      import { type C } from '../../core/types.ts';
      export { type D } from '../../core/types.ts';
      type E = import('../../core/types.ts').E;
      import '../../core/side-effect.ts';
      import { type F, value } from '../../core/mixed.ts';
      export { value as other } from '../../core/value.ts';
    `,
      ],
      ["core/types.ts", "crypto.subtle.digest('SHA-256', bytes)"],
      ["core/side-effect.ts", "export {}"],
      ["core/mixed.ts", "export const value = 1"],
      ["core/value.ts", "export const value = 1"],
    ]),
  );
  assert(!graph.has("core/types.ts"));
  for (
    const path of ["core/side-effect.ts", "core/mixed.ts", "core/value.ts"]
  ) {
    assert(graph.has(path), path);
  }
});
