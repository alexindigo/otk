// SPDX-License-Identifier: LGPL-3.0-only
import { assert } from "@std/assert";

Deno.test("component-owned CSS is imported by its owner and retains structural terminal geometry", async () => {
  const base = new URL("../", import.meta.url);
  let owned = 0;
  async function inspect(directory: URL): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      const file = new URL(
        entry.name + (entry.isDirectory ? "/" : ""),
        directory,
      );
      if (entry.isDirectory) {
        await inspect(file);
        continue;
      }
      if (!entry.name.endsWith(".css")) continue;
      const owner = new URL(entry.name.replace(/\.css$/, ".tsx"), directory);
      const source = await Deno.readTextFile(owner);
      assert(
        source.includes(`import "./${entry.name}" with { type: "text" };`),
        `${entry.name} must be imported by its component`,
      );
      const css = await Deno.readTextFile(file);
      assert(
        !/\b(?:top|left|right|bottom)\s*:\s*calc\(/.test(css),
        `${entry.name} must not introduce arithmetic alignment`,
      );
      owned++;
    }
  }
  await inspect(new URL("components/", base));
  assert(owned > 0, "No component-owned styles were inspected");
  const message = await Deno.readTextFile(
    new URL("components/Message.css", base),
  );
  assert(
    message.includes(".otk-message-footer") &&
      message.includes("align-items: center"),
  );
  const code = await Deno.readTextFile(new URL("components/Code.css", base));
  assert(code.includes("grid-template-columns: auto minmax(0, 1fr)"));
  const theme = await Deno.readTextFile(new URL("theme.css", base));
  for (
    const token of [
      "--bg: var(--otk-bg)",
      "--fg: var(--otk-fg)",
      "--accent: var(--otk-accent-text)",
      '"IBM Plex Mono"',
    ]
  ) assert(theme.includes(token));
  // The same branding assertions now observe the sole palette owner.
  const dark = JSON.parse(
    await Deno.readTextFile(new URL("features/theme/otk-dark.json", base)),
  );
  for (
    const [slot, value] of Object.entries({
      bg: "#1a1c1e",
      fg: "#e0e6ed",
      accent: "#ff4d00",
    })
  ) {
    assert(dark.colors[slot] === value);
  }
});
