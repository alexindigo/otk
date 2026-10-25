// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { productionSources, Source } from "./analysis.ts";

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
