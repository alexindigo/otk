// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";
import { property } from "./syntax.ts";

function sessionRpcErrors(files: Map<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, text] of files) {
    if (
      !/^(packages\/(?:client|ui)\/|web\/src\/)/.test(path) ||
      path.endsWith(".css")
    ) continue;
    if (path === "packages/client/session-actions.ts") continue;
    // Command identities are allowed; RPC invocation crosses the owner boundary.
    const source = new Source(text, path);
    for (const call of source.calls("call")) {
      if (
        [
          "session.rename",
          "session.delete",
          "session.fork",
          "session.compact",
          "session.revert",
          "session.restore",
        ].includes(source.string(call.arguments[0]) ?? "")
      ) errors.push(path);
    }
  }
  return errors;
}

Deno.test("session-target RPC operations have one framework-free owner", async () => {
  assertEquals(sessionRpcErrors(await productionSources()), []);
  for (
    const path of [
      "packages/ui/shell/Shell.tsx",
      "packages/ui/shell/session-ports.ts",
      "packages/ui/components/Other.tsx",
    ]
  ) {
    assertEquals(
      sessionRpcErrors(new Map([[path, 'rpc.call("session.rename", target)']])),
      [path],
    );
  }
});

function nativeMutationErrors(files: Map<string, string>): string[] {
  const errors: string[] = [];
  for (const [path, text] of files) {
    if (
      path.startsWith("packages/harness-opencode1/") || path.endsWith(".css")
    ) continue;
    const source = new Source(text, path);
    for (const call of source.all) {
      if (call.type !== "CallExpression") continue;
      const argument = source.value(call.arguments[0]);
      const route = argument?.type === "TemplateLiteral"
        ? argument.quasis.map((part) => part.value.cooked).join("*")
        : source.string(argument);
      if (!route?.startsWith("/session/")) continue;
      const options = source.value(call.arguments[1]);
      const remove = options?.type === "ObjectExpression" &&
        options.properties.some((field) =>
          field.type === "ObjectProperty" && property(field.key) === "method" &&
          source.string(field.value) === "DELETE"
        );
      if (remove || /\/(?:revert|unrevert|fork|summarize)$/.test(route)) {
        errors.push(path);
      }
    }
  }
  return errors;
}

Deno.test("native session mutations stay inside the opencode adapter", async () => {
  assertEquals(nativeMutationErrors(await productionSources()), []);
  for (
    const code of [
      'client.json(`/session/${id}`, {method: "DELETE"})',
      "client.json(`/session/${id}/revert`)",
      "fetch(`/session/${id}/fork`)",
    ]
  ) {
    assertEquals(
      nativeMutationErrors(new Map([["core/features/other.ts", code]])),
      ["core/features/other.ts"],
    );
  }
});

Deno.test("messages contribute no commands and hover rows invoke only command identities", async () => {
  const files = await productionSources();
  const message = new Source(
    files.get("packages/ui/components/Message.tsx")!,
    "Message.tsx",
  );
  for (const name of ["register", "ownedCommand", "ownedAction"]) {
    assertEquals(message.calls(name).length, 0);
  }
  const actions = new Source(
    files.get("packages/ui/components/MessageActions.tsx")!,
    "MessageActions.tsx",
  );
  for (
    const name of ["register", "ownedCommand", "ownedAction", "call", "fetch"]
  ) {
    assertEquals(actions.calls(name).length, 0);
  }
  assertEquals(actions.calls("run").length > 0, true);
});
