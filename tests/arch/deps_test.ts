// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

// kit-repackaging §2.1. Check every package that exists, without pretending
// legacy directories have already undergone the later extraction chunks.
const allowed: Record<string, readonly string[]> = {
  protocol: [],
  content: ["protocol"],
  harness: ["protocol"],
  "harness-opencode1": ["protocol", "content", "harness"],
  store: [],
  client: ["protocol"],
  ui: ["protocol", "client"],
};
const root = new URL("../../", import.meta.url);
const owner = (path: string) => /^packages\/([^/]+)\//.exec(path)?.[1];
const isTest = (path: string) => /(^|\/)tests\//.test(path);

// Tokenize comments and string literals as units so documentation, browser
// script strings and commented imports cannot masquerade as dependencies.
function imports(source: string): (string | undefined)[] {
  const tokens = Array.from(
    source.matchAll(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g,
    ),
    (match) => match[0],
  ).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const literal = (token: string | undefined): string | undefined => {
    if (!token || !/^["'`]/.test(token) || token.includes("${")) return;
    // Escaped specifiers are rejected rather than letting an encoded path
    // bypass the public boundary check.
    if (token.includes("\\")) return;
    return token.slice(1, -1);
  };
  const result: (string | undefined)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const kind = tokens[i];
    if (kind !== "import" && kind !== "export") continue;
    const next = tokens[i + 1];
    if (next === ".") continue; // import.meta
    if (kind === "import" && next === "(") {
      result.push(tokens[i + 3] === ")" ? literal(tokens[i + 2]) : undefined);
      continue;
    }
    if (kind === "import" && /^["'`]/.test(next ?? "")) {
      result.push(literal(next));
      continue;
    }
    if (kind === "export" && !["*", "{", "type"].includes(next)) continue;
    for (let j = i + 1; j < tokens.length && tokens[j] !== ";"; j++) {
      if (tokens[j] !== "from" || !/^["'`]/.test(tokens[j + 1] ?? "")) continue;
      result.push(literal(tokens[j + 1]));
      break;
    }
  }
  return result;
}

function dependencyError(
  path: string,
  specifier: string | undefined,
  present: ReadonlySet<string>,
): string | undefined {
  const from = owner(path), production = from && !isTest(path);
  if (specifier === undefined) {
    return production ? "non-literal dependency cannot be checked" : undefined;
  }
  if (specifier.startsWith("@otk/") || specifier.startsWith("jsr:@otk/")) {
    const match = /^@otk\/([\w-]+)$/.exec(specifier);
    if (!match) return "OTK dependencies must use bare public package names";
    const to = match[1];
    if (!present.has(to)) return `package ${to} is not in this workspace`;
    if (production && from !== to && !allowed[from]?.includes(to)) {
      return `${from} must not depend on ${to}`;
    }
    return;
  }
  if (/^(?:\.|\/|file:)/.test(specifier)) {
    const target = new URL(
      specifier,
      new URL(path.split("/").map(encodeURIComponent).join("/"), root),
    );
    const targetPath = target.href.startsWith(root.href)
      ? decodeURIComponent(target.href.slice(root.href.length))
      : undefined;
    const to = targetPath && owner(targetPath);
    if (to && to !== from) return "cross-package paths bypass the public entry";
    if (production && (!targetPath || to !== from)) {
      return "package imports must not escape into legacy or external source";
    }
    if (targetPath?.startsWith("protocol/")) {
      return "old protocol path is retired";
    }
    if (
      targetPath &&
      /^(?:sidecar\/adapter\/|sidecar\/history\/)/.test(targetPath)
    ) {
      return "old harness paths are retired";
    }
    if (targetPath?.startsWith("sidecar/db/")) {
      return "old store paths are retired";
    }
    if (
      targetPath &&
      /^web\/src\/(?:net\/|state\/(?:reduce|messages|permissions|navigation)\.ts)/
        .test(targetPath)
    ) {
      return "framework-free client paths are retired into @otk/client";
    }
    if (
      targetPath &&
      /^web\/src\/(?:highlight\/|state\/|ui\/(?!App\.(?:tsx|css)$))/.test(
        targetPath,
      )
    ) {
      return "UI components, highlighting and bindings are owned by @otk/ui";
    }
    if (
      targetPath &&
      /^sidecar\/(?:auth|config|features|http|index|static|ws)\//.test(
        targetPath,
      )
    ) {
      return "old sidecar application paths are retired into core";
    }
    return;
  }
  if (production && from === "protocol") {
    return "protocol must be dependency-free";
  }
  if (production && from === "client" && /solid/i.test(specifier)) {
    return "client must remain framework-free";
  }
  if (production && from === "client") return "client depends only on protocol";
  if (
    production && from !== "harness-opencode1" && /opencode/i.test(specifier)
  ) {
    return "native opencode dependencies belong to harness-opencode1";
  }
}

function sourceErrors(path: string, source: string): string[] {
  const from = owner(path);
  if (isTest(path)) return [];
  if (!from && !/^(?:main\.ts$|core\/|web\/src\/)/.test(path)) return [];
  const errors: string[] = [];
  if (from) {
    for (
      const match of source.matchAll(
        /new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
      )
    ) {
      const error = dependencyError(
        path,
        match[1],
        new Set(Object.keys(allowed)),
      );
      if (error) errors.push(`static asset ${match[1]}: ${error}`);
    }
  }
  if (
    from !== "harness-opencode1" &&
    /["'`]\/(?:global\/(?:event|health)|experimental\/(?:session|resource)|session(?:\/|["'`])|permission(?:\/|["'`])|question(?:\/|["'`])|find\/file|agent["'`]|command["'`]|skill["'`]|mcp["'`])/
      .test(source)
  ) {
    errors.push("native opencode endpoints belong to harness-opencode1");
  }
  if (
    from !== "harness-opencode1" &&
    /(?:FROM|JOIN|CREATE TABLE|PRAGMA table_info\()\s*(?:message|part|session)\b/i
      .test(source)
  ) {
    errors.push("native database schema belongs to harness-opencode1");
  }
  if (
    /(?:^|\/)(?:registries\/|registry(?:\.ts|\/)|[^/]+-registry\.ts)/.test(
      path,
    ) ||
    /^packages\/store\/(?:db|migrations)\.ts$/.test(path)
  ) {
    if (
      imports(source).some((specifier) =>
        specifier &&
        /(?:^|\/)(?:features\/|components\/(?:tools|parts)\/)/.test(specifier)
      )
    ) {
      errors.push(
        "registries and migration runners must not import their feature implementations",
      );
    }
  }
  if (
    /^packages\/ui\/components\/(?:Message|ToolLine)\.tsx$/.test(path) &&
    /\b(?:Switch|Match)\b/.test(source)
  ) {
    errors.push("UI part/tool dispatch must use consumer-owned registries");
  }
  return errors;
}

async function* sources(directory: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    if (
      ["node_modules", "dist", ".test-state", "tmp", "arch"].includes(
        entry.name,
      )
    ) continue;
    const url = new URL(
      encodeURIComponent(entry.name) + (entry.isDirectory ? "/" : ""),
      directory,
    );
    if (entry.isDirectory) yield* sources(url);
    else if (/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(entry.name)) yield url;
  }
}

Deno.test("extracted package metadata and imports follow public downward dependencies", async () => {
  const present = new Set<string>();
  for await (const entry of Deno.readDir(new URL("packages/", root))) {
    if (!entry.isDirectory) continue;
    assert(
      Object.hasOwn(allowed, entry.name),
      `Unplanned package ${entry.name}`,
    );
    present.add(entry.name);
    const base = new URL(`packages/${entry.name}/`, root);
    const config = JSON.parse(
      await Deno.readTextFile(new URL("deno.json", base)),
    );
    assertEquals(config.name, `@otk/${entry.name}`);
    assertEquals(config.version, "0.1.0");
    assertEquals(config.license, "LGPL-3.0-only");
    assertEquals(config.exports, "./mod.ts");
    // An import map must not silently redirect an approved dependency into a
    // private module or an upward package.
    for (const [key, value] of Object.entries(config.imports ?? {})) {
      assert(
        !key.startsWith("@otk/"),
        `Workspace resolves ${key}, not package import maps`,
      );
      const error = dependencyError(
        `packages/${entry.name}/deno.json`,
        String(value),
        present,
      );
      assert(!error, `${entry.name}: ${error}`);
    }
    await Deno.stat(new URL("mod.ts", base));
    await Deno.stat(new URL("README.md", base));
    await Deno.stat(new URL("tests/", base));
    assertEquals(
      await Deno.readTextFile(new URL("LICENSE", base)),
      await Deno.readTextFile(new URL("LICENSE", root)),
    );
  }
  assert(present.has("protocol"));
  const config = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", root)),
  );
  assertEquals(config.workspace, ["./packages/*"]);
  for (const [key, value] of Object.entries(config.imports ?? {})) {
    assert(
      !key.startsWith("@otk/"),
      `Workspace resolves ${key}, not the root import map`,
    );
    assert(
      !String(value).includes("packages/"),
      `Root alias ${key} bypasses workspace exports`,
    );
  }
  let files = 0, edges = 0;
  const errors: string[] = [];
  const urls = [new URL("main.ts", root)];
  for (const directory of ["packages/", "core/", "web/src/", "tests/"]) {
    for await (const url of sources(new URL(directory, root))) {
      urls.push(url);
    }
  }
  for (const url of urls) {
    const path = decodeURIComponent(url.href.slice(root.href.length));
    const source = await Deno.readTextFile(url);
    files++;
    for (const specifier of imports(source)) {
      edges++;
      const error = dependencyError(path, specifier, present);
      if (error) errors.push(`${path}: ${specifier}: ${error}`);
    }
    errors.push(
      ...sourceErrors(path, source).map((error) => `${path}: ${error}`),
    );
  }
  console.info("Dependency architecture", {
    packages: [...present],
    files,
    edges,
  });
  assertEquals(errors, []);
});

Deno.test("dependency checks reject private paths, upward edges and legacy escapes", () => {
  const present = new Set(Object.keys(allowed));
  for (
    const [path, specifier] of [
      ["web/src/net/rpc.ts", "../../../packages/protocol/mod.ts"],
      [
        "sidecar/http/routes/#...path/get.ts",
        "../../../../packages/protocol/mod.ts",
      ],
      ["tests/reuse/consumer.ts", "../../packages/protocol/content.ts"],
      ["sidecar/ws/rpc.ts", "@otk/protocol/content.ts"],
      ["sidecar/ws/rpc.ts", "jsr:@otk/protocol"],
      ["packages/protocol/mod.ts", "@otk/content"],
      ["packages/ui/mod.ts", "@otk/sidecar"],
      ["packages/store/mod.ts", "@otk/protocol"],
      ["packages/content/mod.ts", "../../sidecar/content/markdown.ts"],
      ["packages/protocol/mod.ts", "npm:ws"],
      ["packages/client/mod.ts", "solid-js"],
      ["packages/content/mod.ts", "npm:@opencode-ai/sdk"],
      ["tests/unit/example.ts", "../../protocol/content.ts"],
      ["tests/unit/example.ts", "../../sidecar/adapter/opencode1/map.ts"],
      ["tests/unit/example.ts", "../../sidecar/history/history.ts"],
      ["tests/unit/example.ts", "../../sidecar/db/db.ts"],
      ["sidecar/ws/rpc.ts", "../db/prefs.ts"],
      ["packages/store/features/prefs.ts", "@otk/harness"],
      ["main.ts", "@otk/sidecar"],
      ["main.ts", "@otk/server"],
      ["main.ts", "@otk/app"],
      ["packages/harness-opencode1/adapter.ts", "../../core/mod.ts"],
      ["packages/client/mod.ts", "../../main.ts"],
      ["tests/unit/example.ts", "../../sidecar/auth/state.ts"],
      ["packages/client/rpc.ts", "npm:ws"],
      ["tests/unit/example.ts", "../../web/src/state/reduce.ts"],
      ["packages/ui/mod.ts", "../../web/src/ui/App.tsx"],
      ["packages/ui/mod.ts", "@otk/harness-opencode1"],
      ["web/src/ui/App.tsx", "../state/session.ts"],
    ]
  ) assert(dependencyError(path, specifier, present), `${path}: ${specifier}`);
  assert(dependencyError("packages/protocol/mod.ts", undefined, present));
  assert(dependencyError("web/src/net/rpc.ts", "@otk/missing", present));
  for (
    const [path, specifier] of [
      ["packages/content/mod.ts", "@otk/protocol"],
      ["packages/harness-opencode1/mod.ts", "@otk/content"],
      ["packages/ui/mod.ts", "@otk/client"],
      ["main.ts", "@otk/ui"],
      ["packages/protocol/mod.ts", "./messages.ts"],
      ["packages/protocol/tests/example.ts", "@std/assert"],
      ["core/ws/registry.ts", "@otk/protocol"],
      ["main.ts", "@otk/store"],
      ["packages/store/features/prefs.ts", "../db.ts"],
      ["main.ts", "@otk/harness-opencode1"],
      ["core/service.ts", "@otk/store"],
    ]
  ) assertEquals(dependencyError(path, specifier, present), undefined);
});

Deno.test("dependency scanner covers types, re-exports, side effects and dynamic imports", () => {
  assertEquals(
    imports(`
    // import "@otk/ignored";
    /* export * from "@otk/ignored"; */
    const example = 'import "@otk/ignored";';
    import type { Message } from "@otk/protocol";
    export type { Block } from "@otk/protocol";
    export * from "./messages.ts";
    import "./setup.ts";
    const lazy = import("@otk/content");
    type Shape = import("@otk/protocol").Message;
    const computed = import(name);
    const here = import.meta.url;
  `),
    [
      "@otk/protocol",
      "@otk/protocol",
      "./messages.ts",
      "./setup.ts",
      "@otk/content",
      "@otk/protocol",
      undefined,
    ],
  );
});

Deno.test("native endpoints and feature imports cannot leak into extracted shared packages", () => {
  const endpoint = "fetch(`/session/${id}/message`)";
  assertEquals(sourceErrors("packages/protocol/rpc.ts", endpoint).length, 1);
  assertEquals(
    sourceErrors("packages/harness-opencode1/sessions.ts", endpoint),
    [],
  );
  assertEquals(sourceErrors("tests/integration/example.ts", endpoint), []);
  assertEquals(sourceErrors("core/ws/registry.ts", endpoint).length, 1);
  assertEquals(
    sourceErrors(
      "packages/harness/history.ts",
      'db.prepare("SELECT data FROM message")',
    ).length,
    1,
  );
  assertEquals(
    sourceErrors(
      "packages/harness-opencode1/history.ts",
      'db.prepare("SELECT data FROM message")',
    ),
    [],
  );
  const feature = 'import { register } from "./features/sessions.ts";';
  assertEquals(sourceErrors("core/ws/registry.ts", feature).length, 1);
  assertEquals(
    sourceErrors("core/rpc-registry.ts", feature).length,
    1,
  );
  assertEquals(sourceErrors("main.ts", feature), []);
  assertEquals(sourceErrors("packages/store/db.ts", feature).length, 1);
  assertEquals(sourceErrors("packages/store/migrations.ts", feature).length, 1);
  assertEquals(
    sourceErrors(
      "packages/ui/highlight/worker.ts",
      'new URL("../../../node_modules/shiki/dist/onig.wasm", import.meta.url)',
    ).length,
    1,
  );
  assertEquals(
    sourceErrors(
      "packages/ui/highlight/worker.ts",
      'new URL("shiki/onig.wasm", import.meta.url)',
    ),
    [],
  );
  assertEquals(
    sourceErrors(
      "packages/ui/registries/tools.ts",
      'import "../components/tools/BashTool.tsx";',
    ).length,
    1,
  );
  assertEquals(
    sourceErrors(
      "packages/ui/registries/parts.ts",
      'import "../components/parts/TextPart.tsx";',
    ).length,
    1,
  );
  assertEquals(
    sourceErrors("packages/ui/components/ToolLine.tsx", "return Switch(call);")
      .length,
    1,
  );
  assertEquals(
    sourceErrors(
      "core/ws/registry.ts",
      'import type { RpcMethod } from "@otk/protocol";',
    ),
    [],
  );
});

Deno.test("standalone sessions consumer imports only the harness public entries", async () => {
  const consumer = await Deno.readTextFile(
    new URL("tests/reuse/harness-consumer.ts", root),
  );
  assertEquals(imports(consumer), ["@otk/harness", "@otk/harness-opencode1"]);
});

Deno.test("standalone client consumer imports only its public framework-free entry", async () => {
  const consumer = await Deno.readTextFile(
    new URL("tests/reuse/client-consumer.ts", root),
  );
  assertEquals(imports(consumer), ["@otk/client"]);
});

Deno.test("independent UI consumer imports public kit entries without application or backend source", async () => {
  const consumer = await Deno.readTextFile(
    new URL("tests/reuse/ui-consumer/main.tsx", root),
  );
  assertEquals(imports(consumer), [
    "solid-js",
    "@solidjs/web",
    "@otk/protocol",
    "@otk/ui",
    "@fontsource/ibm-plex-mono/400.css",
  ]);
});
