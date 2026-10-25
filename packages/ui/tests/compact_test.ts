// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { CommandHub, effectiveSelection, emptyDraft } from "@otk/client";
import type { PromptContext } from "../registries/prompt.ts";

Deno.test("compact is prompt-scoped, current-target-only and captures the shared next model after readiness", async () => {
  const { registerCompactCommand } = await import(
    "../features/prompt/compact.ts"
  );
  const commands = new CommandHub(() => ({ sidecar: "one", session: "shown" }));
  const ready = Promise.withResolvers<void>();
  let draft = { ...emptyDraft(), model: { provider: "before", model: "old" } };
  let connected = true, active = true, supported = true, child = false;
  const calls: unknown[] = [];
  const ctx = {
    commands,
    active: () => active,
    supports: () => supported,
    sessionID: () => "shown",
    entry: () => ({ parentID: child ? "parent" : undefined }),
    props: {
      get connected() {
        return connected;
      },
      get value() {
        return draft;
      },
    },
    change: (change: (value: typeof draft) => typeof draft) => change(draft),
    nextSelection: (value = draft) => effectiveSelection(value, { agents: [] }),
    ready: () => ready.promise,
    compact: (model: unknown) => {
      calls.push(model);
      return Promise.resolve();
    },
  } as unknown as PromptContext;
  const release = registerCompactCommand(ctx);
  const shown = { sidecarId: "one", sessionID: "shown" };
  try {
    assertEquals(
      commands.contextActions({
        kind: "session",
        data: { ...shown, sessionID: "other" },
      }),
      [],
    );
    assertEquals(
      commands.contextActions({
        kind: "session",
        data: { ...shown, sidecarId: "two" },
      }),
      [],
    );
    assertEquals(
      commands.contextActions({ kind: "session", data: shown }).map((a) =>
        a.title
      ),
      ["Compact"],
    );
    const running = commands.run("session.compact");
    await Promise.resolve();
    assertEquals(calls, []);
    draft = { ...draft, model: { provider: "ready", model: "current" } };
    ready.resolve();
    await running;
    assertEquals(calls, [{ provider: "ready", model: "current" }]);
    assertEquals(commands.resolveSlash("compact"), undefined);
    for (const state of ["disconnected", "unsupported", "child", "retired"]) {
      connected = state !== "disconnected";
      supported = state !== "unsupported";
      child = state === "child";
      active = state !== "retired";
      assertEquals(
        commands.contextActions({ kind: "session", data: shown }),
        [],
      );
      await assertRejects(
        () => commands.run("session.compact"),
        Error,
        "unavailable",
      );
    }
  } finally {
    release();
  }
  assertEquals(commands.has("session.compact"), false);
});
