// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { CommandHub } from "@otk/client";
import { registerCompactCommand } from "../features/prompt/compact.ts";
import { registerSlashPrompt } from "../features/prompt/slash.ts";
import { type PromptContext, PromptRegistry } from "../registries/prompt.ts";

Deno.test("an available compact action appears in the slash source", async () => {
  const commands = new CommandHub(() => ({ sidecar: "one", session: "root" }));
  const releases: (() => void)[] = [];
  const ctx = {
    commands,
    active: () => true,
    supports: () => true,
    sessionID: () => "root",
    entry: () => ({ parentID: undefined }),
    props: { connected: true, suspended: false },
    nextSelection: () => ({
      input: { model: { provider: "fixture", model: "fixture" } },
    }),
    compact: () => Promise.resolve(),
    own: (release: () => void) => releases.push(release),
    mount: (setup: () => void | (() => void)) => {
      const release = setup();
      if (release) releases.push(release);
    },
  } as unknown as PromptContext;
  const releaseCompact = registerCompactCommand(ctx);
  const registry = new PromptRegistry();
  registerSlashPrompt(registry);
  const slash = registry.create(ctx)[0];
  try {
    assertEquals(commands.enabled("session.compact"), true);
    const options = await slash.source!.options({
      start: 0,
      end: 1,
      query: "compact",
    });
    assertEquals(
      options.some((option) => option.command?.name === "compact"),
      true,
    );
  } finally {
    for (const release of releases) release();
    releaseCompact();
  }
});

Deno.test("slash parses registered arguments and retains the command draft on refusal", async () => {
  const commands = new CommandHub(), registry = new PromptRegistry();
  const releases: (() => void)[] = [],
    errors: unknown[] = [],
    calls: string[] = [];
  let draft = {
    input: "/fixture.echo a quoted phrase",
    mode: "normal",
    chips: [],
  };
  const ctx = {
    commands,
    props: { connected: false },
    active: () => true,
    fail: (error: unknown) => errors.push(error),
    change: (update: (value: typeof draft) => typeof draft) =>
      draft = update(draft),
    own: (release: () => void) => releases.push(release),
    mount: (setup: () => void | (() => void)) => {
      const release = setup();
      if (release) releases.push(release);
    },
  } as unknown as PromptContext;
  registerSlashPrompt(registry);
  const feature = registry.create(ctx)[0];
  const before = feature.source!.revision!();
  const release = commands.register({
    id: "fixture.echo",
    title: "Echo",
    category: "Fixture",
    source: "server",
    arguments: { type: "string" },
    run: (_ctx, text: string) => {
      calls.push(text);
    },
  });
  try {
    assertEquals(feature.source!.revision!() !== before, true);
    assertEquals(
      await feature.beforeSubmit!(
        draft as Parameters<NonNullable<typeof feature.beforeSubmit>>[0],
      ),
      true,
    );
    assertEquals(calls, ["a quoted phrase"]);
    draft = { ...draft, input: "/fixture.echo" };
    const original = draft;
    assertEquals(
      await feature.beforeSubmit!(
        draft as Parameters<NonNullable<typeof feature.beforeSubmit>>[0],
      ),
      true,
    );
    assertEquals(draft, original);
    assertEquals(errors.length, 1);
    assertEquals(calls, ["a quoted phrase"]);
  } finally {
    release();
    releases.forEach((stop) => stop());
  }
});
