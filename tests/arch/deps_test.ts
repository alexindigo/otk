// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";

// Final seven-library dependency table; the application remains at root.
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
  if (!from && !/^(?:(?:main|application)\.ts$|core\/|web\/src\/)/.test(path)) {
    return [];
  }
  const errors: string[] = [];
  if (
    path !== "packages/client/session-tree.ts" &&
    /\bfunction\s+sessionTree\s*\(/.test(source)
  ) {
    errors.push(
      "session hierarchy and task grouping belong to the shared client owner",
    );
  }
  if (
    path !== "packages/client/context-meter.ts" &&
    /\bfunction\s+contextMeter\s*\(/.test(source)
  ) {
    errors.push("reported usage projection belongs to the shared client owner");
  }
  if (
    path !== "packages/client/task-actions.ts" &&
    /\bfunction\s+createTaskActions\s*\(/.test(source)
  ) {
    errors.push("task mutation ports belong to the shared client owner");
  }
  if (
    path !== "packages/client/task-breadcrumbs.ts" &&
    /\bfunction\s+taskBreadcrumbs\s*\(/.test(source)
  ) {
    errors.push(
      "task breadcrumb projection belongs to the shared client owner",
    );
  }
  if (
    path !== "packages/client/inbox.ts" &&
    /\bfunction\s+(?:inboxStatus|inboxProjects|rollup|visitTime|ageing)\s*\(/
      .test(source)
  ) {
    errors.push(
      "inbox projections belong to the shared framework-free client owner",
    );
  }
  if (
    path !== "packages/client/tabs.ts" &&
    /\bfunction\s+createTabs\s*\(/.test(source)
  ) {
    errors.push(
      "task, phantom and preview state belongs to the shared client tab model",
    );
  }
  if (
    (from === "harness-opencode1" || path.startsWith("core/index/")) &&
    /#[\w]+\s*(?::[^=;]+)?=\s*new Map<string,\s*IndexEntry>/.test(source)
  ) errors.push("session entries belong only to the shared SessionIndex owner");
  if (
    from === "harness-opencode1" &&
    path !== "packages/harness-opencode1/messages.ts" &&
    /["'`]\/session\/[^\n]*\/message["'`]/.test(source)
  ) {
    errors.push(
      "message collections belong only to the bounded Messages reader",
    );
  }
  if (
    /\bPRAGMA\s+user_version\b/i.test(source) &&
    path !== "packages/store/legacy.ts"
  ) {
    errors.push(
      "global database versions belong only to the frozen legacy bridge",
    );
  }
  if (
    from === "store" &&
    (/\bmigration\.id\b|\breadonly\s+id\s*:\s*number\b/.test(source) ||
      (/^packages\/store\/(?:db|migrations)\.ts$/.test(path) &&
        /\bfeature\s*:\s*["']|\bmigrations\s*:\s*readonly\s+Migration\[\]/.test(
          source.replace(/export interface FeatureMigrations\s*\{[^}]+\}/, ""),
        )))
  ) {
    errors.push(
      "database upgrades must be caller-composed feature-owned lists",
    );
  }
  if (
    /\btype\s+CapabilityName\s*=/.test(source) &&
    (path !== "packages/protocol/capabilities.ts" ||
      !/\btype\s+CapabilityName\s*=\s*Extract<keyof CapabilityContracts, string>\s*;/
        .test(source))
  ) errors.push("capability names derive only from the open protocol contract");
  if (/\btype\s+CapabilityContracts\s*=/.test(source)) {
    errors.push("capability contracts must be declaration-mergeable");
  }
  if (
    /\binterface\s+Capabilities\b/.test(source) ||
    (/\btype\s+Capabilities\s*=/.test(source) &&
      (path !== "packages/protocol/capabilities.ts" ||
        !/\btype\s+Capabilities\s*=\s*Partial<CapabilityContracts>\s*;/.test(
          source,
        )))
  ) errors.push("harness capabilities must derive from the protocol contract");
  if (
    path === "packages/protocol/capabilities.ts" &&
    /interface\s+CapabilityContracts(?:\s+extends[^{}]+)?\s*\{\s*[^\s}]/.test(
      source,
    )
  ) errors.push("capability composition selects owners, never concrete names");
  if (
    /\bcapabilit(?:y|ies)\??\s*:\s*(?:readonly\s+)?string\b|\bsupports\s*\(\s*\w+\s*:\s*string\b|#capabilities\s*=\s*new Set<string>/
      .test(source)
  ) errors.push("capability consumers must use the shared CapabilityName type");
  if (
    !/^packages\/protocol\/capabilities\//.test(path) &&
    /\b(?:\w*[Cc]apabilit\w*|capabilities)\s*(?::[^=;]+)?=\s*(?:Object\.freeze\(\s*)?\[\s*["']/
      .test(source)
  ) errors.push("capability name lists belong to feature-owned contracts");
  if (/\btype\s+Preferences\s*=/.test(source)) {
    errors.push(
      "preference contracts must be a declaration-mergeable interface",
    );
  }
  if (path === "packages/protocol/prefs.ts") {
    if (/\binterface\s+Preferences\s*\{\s*[^\s}]/.test(source)) {
      errors.push(
        "preference keys belong to feature contributions, not the registry",
      );
    }
    if (
      imports(source).some((specifier) =>
        specifier !== "./preference-contract.ts"
      ) || /\b(?:switch\s*\(|if\s*\(\s*key\s*===)/.test(source)
    ) {
      errors.push(
        "preference registry must not import owners or dispatch on concrete keys",
      );
    }
  }
  if (
    path === "packages/protocol/preference-contract.ts" &&
    /interface\s+Preferences(?:\s+extends[^{}]+)?\s*\{\s*[^\s}]/.test(source)
  ) {
    errors.push("preference contract composition must not own concrete keys");
  }
  if (/\b(?:const|let)\s+DEFAULT_PREFS\s*(?::[^=]+)?=\s*\{/.test(source)) {
    errors.push("preference defaults must derive from contributions");
  }
  if (
    /\btype\s+PreferenceKey\s*=/.test(source) &&
    !/\btype\s+PreferenceKey\s*=\s*Extract<keyof Preferences, string>\s*;/.test(
      source,
    )
  ) {
    errors.push(
      "preference keys must derive from the open Preferences interface",
    );
  }
  if (
    [
      "packages/ui/components/DisplayMenu.tsx",
      "packages/client/preference-commands.ts",
    ].includes(path) &&
    /["'](?:timestamps|thinking|toolDetails|conceal|genericToolOutput|diffWrap|diffStyle|scrollbar|pasteSummary)["']/
      .test(source)
  ) {
    errors.push(
      "preference menu and commands must consume contributed metadata, not their own key lists",
    );
  }
  if (
    path === "packages/protocol/preferences/theme.ts" &&
    !/interface\s+ThemePreferences\s*\{\s*theme:\s*string\s*;/.test(source)
  ) {
    errors.push("theme identity must remain an open string contract");
  }
  if (
    /\btype\s+RpcMethod\s*=/.test(source) &&
    !/\btype\s+RpcMethod\s*=\s*keyof\s+RpcMethods\s*;/.test(source)
  ) {
    errors.push(
      "RPC method names must derive from the open RpcMethods interface",
    );
  }
  if (/\btype\s+RpcMethods\s*=/.test(source)) {
    errors.push("RPC contracts must be a declaration-mergeable interface");
  }
  for (
    const [alias, registry, external] of [
      ["ToolCall", "ToolKinds", "ExternalCall"],
      ["Part", "PartKinds", "ExternalPart"],
    ]
  ) {
    if (
      new RegExp(`\\btype\\s+${alias}\\s*=`).test(source) &&
      !new RegExp(
        `\\btype\\s+${alias}\\s*=\\s*${registry}\\s*\\[\\s*keyof\\s+${registry}\\s*\\]\\s*\\|\\s*${external}\\s*;`,
      ).test(source)
    ) {
      errors.push(
        `${alias} must derive from its open registry and external variant`,
      );
    }
    if (new RegExp(`\\btype\\s+${registry}\\s*=`).test(source)) {
      errors.push(`${registry} must be a declaration-mergeable interface`);
    }
  }
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
  assertEquals([...present].sort(), Object.keys(allowed).sort());
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
  const urls = [new URL("main.ts", root), new URL("application.ts", root)];
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
    sourceErrors("packages/harness-opencode1/messages.ts", endpoint),
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

Deno.test("native message collection reads cannot bypass their bounded owner", () => {
  for (
    const path of [
      "adapter.ts",
      "sessions.ts",
      "tasks.ts",
      "revert.ts",
      "directory.ts",
      "future.ts",
    ]
  ) {
    assertEquals(
      sourceErrors(
        `packages/harness-opencode1/${path}`,
        "client.json(`/session/${id}/message`)",
      ),
      [
        "message collections belong only to the bounded Messages reader",
      ],
    );
  }
  assertEquals(
    sourceErrors(
      "packages/harness-opencode1/adapter.ts",
      "client.json(`/session/${id}/message/${message}`)",
    ),
    [],
  );
});

Deno.test("connector and core cannot retain a second session-index map", async () => {
  for (
    const path of [
      "packages/harness-opencode1/adapter.ts",
      "packages/harness-opencode1/future.ts",
      "core/index/store.ts",
    ]
  ) {
    assertEquals(
      sourceErrors(path, "#entries = new Map<string, IndexEntry>();"),
      ["session entries belong only to the shared SessionIndex owner"],
    );
  }
  const read = (path: string) => Deno.readTextFile(new URL(path, root));
  assert((await read("core/index/store.ts")).includes("extends SessionIndex"));
  assert(
    (await read("core/service.ts")).includes(
      "backend.core.start({\n    index,",
    ),
  );
  assert(
    (await read("packages/harness-opencode1/adapter.ts")).includes(
      "this.#index = sink.index ?? new SessionIndex()",
    ),
  );
});

Deno.test("standalone sessions consumer imports only the harness public entries", async () => {
  const consumer = await Deno.readTextFile(
    new URL("tests/reuse/harness-consumer.ts", root),
  );
  assertEquals(imports(consumer), ["@otk/harness", "@otk/harness-opencode1"]);
});

Deno.test("database upgrades stay feature-owned and the global sequence is frozen compatibility only", async () => {
  const read = (path: string) => Deno.readTextFile(new URL(path, root));
  const runner = await read("packages/store/migrations.ts");
  assert(
    /export interface FeatureMigrations\s*\{\s*readonly feature: string;\s*readonly migrations: readonly Migration\[\];\s*\}/
      .test(runner),
  );
  assert(/readonly version: number;/.test(runner));
  assert(/PRIMARY KEY \(feature, version\)/.test(runner));
  const db = await read("packages/store/db.ts");
  assert(/migrations: readonly FeatureMigrations\[\]/.test(db));
  for (const path of ["packages/store/db.ts", "packages/store/migrations.ts"]) {
    assertEquals(sourceErrors(path, await read(path)), []);
  }
  for (
    const [path, invalid] of [
      [
        "packages/store/migrations.ts",
        'db.prepare("PRAGMA user_version").get();',
      ],
      ["packages/store/features/notes.ts", 'db.exec("PRAGMA user_version=3");'],
      ["application.ts", "db.exec(`PRAGMA user_version=${version}`);"],
      [
        "packages/store/migrations.ts",
        "export interface Migration { readonly id: number; }",
      ],
      [
        "packages/store/db.ts",
        "constructor(path: string, migrations: readonly Migration[]) {}",
      ],
      [
        "packages/store/migrations.ts",
        'const migrations = [{ feature: "notes", version: 1 }];',
      ],
    ]
  ) assert(sourceErrors(path, invalid).length, `${path}: ${invalid}`);
  const bridge = await read("packages/store/legacy.ts");
  assertEquals(
    [...bridge.matchAll(/case (\d+):/g)].map((match) => Number(match[1])),
    [0, 1, 2],
  );
  assertEquals(
    [...bridge.matchAll(/feature: "([^"]+)", version: (\d+)/g)].map((
      match,
    ) => [match[1], Number(match[2])]),
    [["prefs", 1], ["prefs", 1], ["frecency", 1]],
  );
  assert(!/\.exec\(|\buser_version\s*=/.test(bridge));
  for (const feature of ["prefs", "frecency"]) {
    const source = await read(`packages/store/features/${feature}.ts`);
    assert(source.includes(`feature: "${feature}"`));
    assert(source.includes(`./migrations/${feature}/001.sql`));
    assert(/version: 1/.test(source));
  }
  for await (
    const entry of Deno.readDir(
      new URL("packages/store/features/migrations/", root),
    )
  ) {
    assert(
      entry.isDirectory,
      "SQL numbering must be scoped to feature directories",
    );
  }
});

Deno.test("RPC contracts stay open and names derive only from the mergeable registry", async () => {
  const protocol = await Deno.readTextFile(
    new URL("packages/protocol/rpc.ts", root),
  );
  assert(
    /export\s+interface\s+RpcMethods(?:\s+extends\s+[\w,\s]+)?\s*\{/.test(
      protocol,
    ),
  );
  assert(
    /export\s+type\s+RpcMethod\s*=\s*keyof\s+RpcMethods\s*;/.test(protocol),
  );
  for (
    const source of [
      'export type RpcMethod = "session.get" | "new.method";',
      'export type RpcMethod = keyof RpcMethods | "new.method";',
      "export type RpcMethods = Record<string, { params: unknown; result: unknown }>;",
    ]
  ) assertEquals(sourceErrors("packages/protocol/rpc.ts", source).length, 1);
  assertEquals(sourceErrors("packages/protocol/rpc.ts", protocol), []);
});

Deno.test("capability names and implementations share one open feature-owned protocol contract", async () => {
  const path = "packages/protocol/capabilities.ts";
  const source = await Deno.readTextFile(new URL(path, root));
  assert(
    /export interface CapabilityContracts\s+extends[^{}]+\{\s*\}/.test(source),
  );
  assert(
    /export type CapabilityName\s*=\s*Extract<keyof CapabilityContracts, string>\s*;/
      .test(source),
  );
  assert(
    /export type Capabilities\s*=\s*Partial<CapabilityContracts>\s*;/.test(
      source,
    ),
  );
  assertEquals(sourceErrors(path, source), []);
  for (
    const [file, invalid] of [
      [path, 'export type CapabilityName = "prompt" | "permissions";'],
      [
        path,
        'export type CapabilityName = Extract<keyof CapabilityContracts, string> | "extra";',
      ],
      [path, "export type CapabilityContracts = Record<string, unknown>;"],
      [
        path,
        "export interface CapabilityContracts { prompt: PromptCapability; }",
      ],
      [
        "packages/harness/types.ts",
        "export interface Capabilities { prompt?: PromptCapability; }",
      ],
      [
        "packages/harness/types.ts",
        "export type CapabilityName = keyof Capabilities;",
      ],
      [
        "packages/harness/types.ts",
        "export type Capabilities = { prompt?: PromptCapability };",
      ],
      [
        "packages/client/connection.ts",
        "supports(capability: string): boolean { return false; }",
      ],
      ["packages/client/connection.ts", "#capabilities = new Set<string>();"],
      ["packages/protocol/messages.ts", "capabilities?: string[];"],
      ["packages/ui/registries/renderers.ts", "capability?: string;"],
      [
        "packages/ui/components/SessionView.tsx",
        "capabilities: readonly string[];",
      ],
      [
        path,
        'const legacyCapabilities: readonly CapabilityName[] = Object.freeze(["prompt", "permissions"]);',
      ],
      ["web/src/ui/App.tsx", 'const capabilities = ["prompt", "permissions"];'],
    ]
  ) assert(sourceErrors(file, invalid).length, `${file}: ${invalid}`);
  for (
    const file of [
      "packages/harness/types.ts",
      "packages/client/connection.ts",
      "packages/client/sidecars.ts",
      "packages/protocol/messages.ts",
      "packages/ui/registries/renderers.ts",
      "packages/ui/components/SessionView.tsx",
      "packages/ui/components/Docks.tsx",
    ]
  ) {
    assertEquals(
      sourceErrors(file, await Deno.readTextFile(new URL(file, root))),
      [],
    );
  }
});

Deno.test("standalone client consumer imports only its public framework-free entry", async () => {
  const consumer = await Deno.readTextFile(
    new URL("tests/reuse/client-consumer.ts", root),
  );
  assertEquals(imports(consumer), ["@otk/client"]);
});

Deno.test("preferences stay feature-owned with an open composed contract and one menu-command contribution list", async () => {
  const read = (path: string) => Deno.readTextFile(new URL(path, root));
  const registry = await read("packages/protocol/prefs.ts");
  const contract = await read("packages/protocol/preference-contract.ts");
  assert(/export interface Preferences\s+extends[^{}]+\{\s*\}/.test(contract));
  assertEquals(
    sourceErrors("packages/protocol/preference-contract.ts", contract),
    [],
  );
  assertEquals(sourceErrors("packages/protocol/prefs.ts", registry), []);
  const composition = await read("packages/protocol/preferences.ts");
  assert(
    /DEFAULT_PREFS:\s*Readonly<Preferences>\s*=\s*preferences\.defaults\(\)/
      .test(composition),
  );
  for (
    const path of [
      "packages/ui/components/DisplayMenu.tsx",
      "packages/client/preference-commands.ts",
    ]
  ) {
    const source = await read(path);
    assert(/\.display\(\)/.test(source));
    assertEquals(sourceErrors(path, source), []);
    assert(
      sourceErrors(path, 'const keys = ["timestamps", "diffStyle"];').length,
    );
  }
  for (
    const source of [
      "export interface Preferences { timestamps: boolean; }",
      "export type Preferences = { theme: string };",
      'export type PreferenceKey = "timestamps" | "theme";',
      "export const DEFAULT_PREFS = { timestamps: false };",
      'import "./preferences/transcript.ts";',
      'if (key === "thinking") return value === "show";',
    ]
  ) assert(sourceErrors("packages/protocol/prefs.ts", source).length);
  assert(
    sourceErrors(
      "packages/protocol/preferences/theme.ts",
      'interface ThemePreferences { theme: "otk-dark" | "otk-light"; }',
    ).length,
  );
});

Deno.test("tool and part contracts remain open with distinct external discriminants", async () => {
  const source = await Deno.readTextFile(
    new URL("packages/protocol/content.ts", root),
  );
  for (const name of ["ToolKinds", "PartKinds"]) {
    assert(new RegExp(`export\\s+interface\\s+${name}\\s*\\{`).test(source));
  }
  assert(
    /interface ExternalCall extends ToolBase\s*\{\s*tool: "external";/.test(
      source,
    ),
  );
  assert(/interface ExternalPart\s*\{\s*kind: "external";/.test(source));
  assertEquals(sourceErrors("packages/protocol/content.ts", source), []);
  for (
    const closed of [
      "export type ToolCall = BashCall | ExternalCall;",
      'export type Part = { kind: "text" } | ExternalPart;',
      "export type ToolCall = ToolKinds[keyof ToolKinds] | ExternalCall | OtherCall;",
      "export type Part = PartKinds[keyof PartKinds] | ExternalPart | OtherPart;",
      "export type ToolKinds = { bash: BashCall };",
      "export type PartKinds = { text: TextPart };",
    ]
  ) {
    assertEquals(
      sourceErrors("packages/protocol/content.ts", closed).length,
      1,
    );
  }
});

Deno.test("independent UI consumer imports public kit entries without application or backend source", async () => {
  const consumer = await Deno.readTextFile(
    new URL("tests/reuse/ui-consumer/main.tsx", root),
  );
  assertEquals(imports(consumer), [
    "solid-js",
    "@solidjs/web",
    "@otk/client",
    "@otk/protocol",
    "@otk/ui",
    "@fontsource/ibm-plex-mono/400.css",
    "@fontsource/ibm-plex-sans/400.css",
    "@fontsource/ibm-plex-sans/500.css",
    "@fontsource/ibm-plex-sans/600.css",
  ]);
});

Deno.test("final application entries compose public kit modules and keep reflective routes outside library publication", async () => {
  const read = (path: string) => Deno.readTextFile(new URL(path, root));
  assertEquals(
    imports(await read("application.ts")).filter((name) =>
      name?.startsWith("@otk/")
    ),
    ["@otk/harness", "@otk/store"],
  );
  assertEquals(
    imports(await read("main.ts")).filter((name) => name?.startsWith("@otk/")),
    ["@otk/harness-opencode1", "@otk/content"],
  );
  assertEquals(imports(await read("web/src/features.ts")), ["@otk/ui"]);
  assertEquals(
    imports(await read("tests/support/core-backend.ts")).filter((name) =>
      name?.endsWith("application.ts")
    ),
    ["../../application.ts"],
  );
  assert((await read("tests/support/sidecar.ts")).includes('"main.ts"'));
  for (
    const path of [
      "sidecar/",
      "protocol/",
      "packages/app/",
      "packages/server/",
      "packages/sidecar/",
      "core/deno.json",
      "tests/support/sidecar-child.ts",
    ]
  ) {
    let exists = true;
    try {
      await Deno.stat(new URL(path, root));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      exists = false;
    }
    assert(!exists, `Obsolete extraction scaffolding: ${path}`);
  }
  const routes = await read("core/http/server.ts");
  assert(routes.includes('new URL("./routes/", import.meta.url)'));
  await Deno.stat(new URL("core/http/routes/%23...path/get.ts", root));
  for (
    const config of [
      "web/vite.config.ts",
      "tests/reuse/ui-consumer/vite.config.ts",
    ]
  ) {
    const source = await read(config);
    const mappings = [
      ...source.matchAll(
        /"(@otk\/([\w-]+))":\s*new URL\("([^"]+)"\s*,\s*import\.meta\.url\)/g,
      ),
    ];
    assertEquals(mappings.map((match) => match[2]).sort(), [
      "client",
      "protocol",
      "ui",
    ]);
    for (const match of mappings) {
      const entry = new URL(match[3], new URL(config, root));
      const metadata = JSON.parse(await read(`packages/${match[2]}/deno.json`));
      assertEquals(
        entry.href,
        new URL(
          `packages/${match[2]}/${metadata.exports.replace(/^\.\//, "")}`,
          root,
        ).href,
      );
    }
  }
});

Deno.test("theme registry and paint engine stay independent of concrete palette data, host persistence and highlight work", async () => {
  for (
    const path of [
      "packages/ui/theme/registry.ts",
      "packages/ui/theme/engine.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(path, root));
    assert(
      imports(source).every((specifier) =>
        specifier && /^\.\/\w+\.ts$/.test(specifier)
      ),
      path,
    );
    assert(!/localStorage|otk\.db|Worker|highlight\//.test(source), path);
  }
  const css = await Deno.readTextFile(new URL("packages/ui/theme.css", root));
  assert(
    !/#[0-9a-f]{3,8}\b/i.test(css),
    "Palette literals belong only to registered theme data",
  );
  for (
    const category of [
      "foreground",
      "token-keyword",
      "token-string",
      "token-comment",
      "token-function",
      "token-constant",
      "token-punctuation",
    ]
  ) {
    assert(
      new RegExp(`--otk-syntax-${category}: var\\(--otk-code-`).test(css),
      category,
    );
  }
});
Deno.test("notification registry is feature/channel agnostic and notification actions cross only public injected ports", async () => {
  const hub = await Deno.readTextFile(
    new URL("packages/client/notifications.ts", root),
  );
  assertEquals(imports(hub), []);
  assert(
    !/Notification\b|AudioContext|document\b|window\b|solid-js|localStorage|\"(?:toast|os|sound|badge)\"/
      .test(hub),
  );
  const application = await Deno.readTextFile(
    new URL("packages/ui/shell/notifications.ts", root),
  );
  assertEquals(imports(application), [
    "@otk/client",
    "@otk/protocol",
    "../features/notify/badge.ts",
    "../features/notify/os.ts",
    "../features/notify/sound.ts",
    "../features/notify/toast.ts",
  ]);
  assert(application.includes('command: "permission.reply"'));
  assert(application.includes("candidates.get(incoming.id) !== incoming"));
  for (const id of ["toast", "os", "sound", "badge"]) {
    const source = await Deno.readTextFile(
      new URL(`packages/ui/features/notify/${id}.ts`, root),
    );
    assert(imports(source).every((name) => name === "@otk/client"), id);
    assert(!/rpc\.call|core\/|harness|otk\.db|localStorage/.test(source), id);
  }
});

Deno.test("inbox and tab models remain reusable, framework-free owners with injected RPC and promotion ports", async () => {
  for (const file of ["inbox", "tabs", "session-tree"]) {
    const path = `packages/client/${file}.ts`,
      source = await Deno.readTextFile(new URL(path, root));
    assertEquals(sourceErrors(path, source), []);
    assert(
      imports(source).every((name) =>
        name === "@otk/protocol" || name?.startsWith("./")
      ),
    );
    assert(
      !/\b(?:window|document|localStorage|WebSocket|Deno)\b|solid-js|@otk\/(?:store|ui|harness)/
        .test(source),
    );
  }
  for (
    const definition of [
      "function rollup() {}",
      "function inboxProjects() {}",
      "function createTabs() {}",
      "function sessionTree() {}",
    ]
  ) {
    assert(sourceErrors("packages/ui/inbox.ts", definition).length);
    assert(sourceErrors("web/src/ui/App.tsx", definition).length);
  }
  assertEquals(
    dependencyError(
      "packages/client/inbox.ts",
      "solid-js",
      new Set(Object.keys(allowed)),
    ),
    "client must remain framework-free",
  );
});

Deno.test("task actions and reported context usage stay in framework-free public client owners", async () => {
  for (const file of ["context-meter", "task-actions", "task-breadcrumbs"]) {
    const path = `packages/client/${file}.ts`;
    assertEquals(
      sourceErrors(path, await Deno.readTextFile(new URL(path, root))),
      [],
    );
  }
  for (
    const definition of [
      "function contextMeter() {}",
      "function createTaskActions() {}",
      "function taskBreadcrumbs() {}",
    ]
  ) {
    assert(
      sourceErrors("packages/ui/components/ProjectTabs.tsx", definition).length,
    );
  }
  const ui = await Deno.readTextFile(
    new URL("packages/ui/components/ProjectTabs.tsx", root),
  );
  assert(ui.includes("props.model.tabs()"));
  assert(ui.includes("contextMeter(props.messages)"));
  assert(!ui.includes("rpc.call("));
});
