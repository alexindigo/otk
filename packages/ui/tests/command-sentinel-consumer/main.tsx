// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import { CommandProvider } from "../../keyboard/context.tsx";
import Palette from "../../components/Palette.tsx";
import CommandMenu from "../../components/CommandMenu.tsx";
import { registerSlashPrompt } from "../../features/prompt/slash.ts";
import { type PromptContext, PromptRegistry } from "../../registries/prompt.ts";

const commands = new CommandHub();
const prompt = new PromptRegistry();
registerSlashPrompt(prompt);
const releases: (() => void)[] = [];
const ctx = {
  commands,
  own: (release: () => void) => releases.push(release),
  mount: (setup: () => void | (() => void)) => {
    const release = setup();
    if (release) releases.push(release);
  },
  props: { connected: false },
  active: () => true,
} as unknown as PromptContext;
const slash = prompt.create(ctx)[0].source!;
render(() => (
  <CommandProvider commands={commands}>
    <Palette onClose={() => {}} />
    <CommandMenu
      label="Sentinel menu"
      trigger="Context"
      targets={() => [{ kind: "sentinel", data: undefined }]}
    />
  </CommandProvider>
), document.getElementById("app")!);
const name = crypto.randomUUID();
// Register after consumers exist, with no slash/palette opt-in metadata.
commands.register({
  id: crypto.randomUUID(),
  name,
  title: name,
  category: "Sentinel",
  context: { kind: "sentinel" },
  run: () => document.body.dataset.executed = name,
});
const options = await slash.options({ start: 0, end: 1, query: name });
const result = document.createElement("output");
result.dataset.sentinel = name;
result.textContent = JSON.stringify(
  options.map((option) => option.command?.name),
);
document.body.append(result);
